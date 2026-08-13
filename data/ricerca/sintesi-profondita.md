# La taratura del filtro di profondità — misura del 13 agosto 2026, ~19:30 UTC

Sola misura. Nessuna modifica a `lib/rewards/profondita-minima.js`, nessuna soglia toccata.
Script: `scripts/ricerca/taratura-profondita.js` · `scripts/ricerca/esiti-contro-gate.js`
Dati: `data/ricerca/taratura-profondita.json`

**Ingressi**: board di agent24 generato `2026-08-13T19:17:05Z` (111 righe, da 1.118 mercati premiati
trovati → 150 processati → 39 soppressi dal `depthFloorUsd $25` di agent24 → 111); profondità dai
campioni **websocket** di agent34 (`min(bidDepthInBand, askDepthInBand)`, mediana, stessa formula di
`allocator.marketMeta`), finestra 60 min.

---

## B1 · Da dove viene q = 0,60

**È un'ASSUNZIONE dichiarata, non un valore derivato dai dati.**

`lib/rewards/realistic-estimate.js:74` — `maxCredibleShare: 0.60`. Il modulo classifica da sé le
proprie correzioni: «Two of the corrections are **DERIVED** (real algebra on the published formula or
on measured data) and two are **ASSUMPTIONS** with a configurable constant. They are labelled as such
in `kind`». `maxCredibleShare` è fra le assunzioni, e la motivazione è qualitativa:

> «0.60 is where "you are the dominant maker" turns into "you ARE the book".»

`lib/rewards/profondita-minima.js:64` la **importa** e non la ridichiara (`MAX_QUOTA_CREDIBILE =
DEFAULTS.maxCredibleShare`), per non creare la sesta copia della stessa costante (rilevatore D1).

**Ciò che È stato misurato è il PUNTO DI APPLICAZIONE, non il valore.** L'header del modulo documenta
l'incidente del 9 agosto 2026 (piano che dichiarava $697/g di lordo, il 67% dell'intero montepremi, e
il 44% al giorno su $588 di capitale; 73 righe su 108 con quota modellata oltre il 60%) e quattro
piani appaiati che mostrano che togliendo il 72% del board la copertura restava identica al centesimo.

**⚠ E il modulo dichiara la propria precondizione di sicurezza, che oggi è violata:**

> «col tetto di concentrazione al 20% servono al minimo CINQUE mercati per coprire il capitale, e il
> pool superstite ne aveva TRENTA — sei volte il necessario. Questo cancello **non può affamare il
> piano finché quel rapporto regge**, e il referto lo pubblica a ogni ciclo perché smetta di essere
> un'ipotesi.»

Il log di agent41 che dice «LA SCALA STA AFFAMANDO IL PIANO» **è quella strumentazione che parla**,
non un guasto nuovo.

---

## B5 · La soglia dipende dal capitale? NO

`scalaProfondita` (`lib/rewards/profondita-minima.js:209`) esclude quando nessuna size piazzabile
resta entro la quota:

```
S_max = depth · q/(1−q)          escluso ⟺ minSize_venue > S_max ⟺ depth < minSize·(1−q)/q
```

Né il capitale del conto né il tetto per mercato compaiono nella condizione. È **deliberato** e
documentato a `profondita-minima.js:69-79`: «La sottigliezza è una proprietà del BOOK, non del nostro
conto, e va misurata a un metro fisso.» *(Il `CAPITALE_RIFERIMENTO_USD_DEFAULT = 500` alla riga 80
riguarda `verdettoProfondita`, il verdetto pubblicato sui candidati — **non** il gate che l'allocatore
applica.)*

A q=0,60 serve `depth ≥ minSize × 0,667`:

| minSize | depth richiesta | mercati sul board | depth misurata (q25 / mediana / q75) |
|---|---|---|---|
| 20 | 13,3 share | 46 | 53,8 / **124,9** / 352,5 |
| 50 | 33,4 | 7 | 13.244 / 22.932 / 31.272 |
| 100 | 66,7 | 38 | 48,6 / 211,7 / 786,3 |
| 200 | 133,4 | 11 | 45.073 / 101.967 / 344.141 |

**La soglia richiesta è ordini di grandezza sotto la profondità tipica.** Non serve un valore diverso
per $650: a q=0,60 il vincolo non morde quasi mai.

---

## B4 · Sensibilità a q

**⚠ `q/(1−q)` è CRESCENTE in q: abbassare q STRINGE il filtro.** q=0,60 è già il più permissivo dei
cinque valori richiesti; per ammettere di più bisognerebbe ALZARLO.

Sui **46 mercati finanziabili** (l'insieme che conta — vedi l'imbuto):

| q | S_max/minSize | ammessi | esclusi | lordo ammesso/g | lordo escluso/g |
|---|---|---|---|---|---|
| 0,20 | 0,25× | 28 | 18 | $1.536 | $985 |
| 0,30 | 0,43× | 36 | 10 | $1.978 | $543 |
| 0,40 | 0,67× | 38 | 8 | $2.081 | $440 |
| 0,50 | 1,00× | 41 | 5 | $2.242 | $279 |
| **0,60** | **1,50×** | **41** | **5** | **$2.242** | **$279** |
| 0,70 – 0,90 | 2,33× – 9,00× | 41 | 5 | $2.242 | $279 |

**Da q=0,50 in su il numero NON CAMBIA PIÙ, e la ragione è decisiva: tutti gli esclusi hanno
`depth` esattamente 0.** Con `depth = 0`, `S_max = 0 · q/(1−q) = 0` per **qualunque** q — nessun
valore della manopola li ammette. I sei (finestra 240 min):

| lordo/g | minSize | depth | mercato |
|---|---|---|---|
| $93 | 20 | 0 | HotSchedules #2 Paid App US App Store |
| $73 | 20 | 0 | lowest temperature in Hong Kong 27°C |
| $59 | 20 | 0 | lowest temperature in London 22°C |
| $50 | 20 | 0 | WTI Crude closes above $81 |
| $50 | 20 | 0 | Gold (XAUUSD) LOW $4.300 |
| $50 | 20 | 0 | Silver (XAGUSD) HIGH $67 |

**Il rischio in più che si prenderebbe alzando q: ZERO in un verso e niente da guadagnare.** Non
esiste un q che liberi capitale. La manopola è la leva sbagliata.

**⚠ La misura è stabile rispetto alla finestra dei campioni** (15/60/240 min ⇒ 39/41/43 ammessi): non
è un artefatto del periodo scelto.

---

## L'imbuto — chi taglia DAVVERO

| passo | mercati | taglia |
|---|---|---|
| sul board | 111 | |
| con profondità websocket misurata | 102 | 9 |
| **FINANZIABILI** (`pavimentoPremiante(minSize) ≤ tetto $32,67`) | **46** | **56** |
| con scadenza ammissibile | 46 | 0 |
| che passano il filtro di profondità q=0,60 | **41** | **5** |
| *minimi per coprire il capitale* | *16* | |

```
pavimentoPremiante(20)  = $ 24,50  ≤ $32,67  ⇒ FINANZIABILE      (46 mercati)
pavimentoPremiante(50)  = $ 61,25  > $32,67  ⇒ mai finanziabile   ( 7 mercati)
pavimentoPremiante(100) = $122,50  > $32,67  ⇒ mai finanziabile   (38 mercati)
pavimentoPremiante(200) = $245,00  > $32,67  ⇒ mai finanziabile   (11 mercati)
```

**Il cancello che toglie 56 mercati su 102 non è la profondità: è il minimo del venue contro il tetto
per mercato**, cioè §4.2 e §5-bis p.117/132, già documentati. Il filtro di profondità toglie 5 mercati
e ne lascia **41 contro i 16 necessari — un margine di 2,6×**, cioè la precondizione di sicurezza del
modulo REGGE sul board intero.

**⚠ Il numero «superstiti 2» del log di agent41 è reale ma NON è questo insieme**: è il *piano
ristretto* (`agent41-realloc-scheduler.js:561`, ramo `onlyMarketIds`), calcolato sui soli mercati già
in gestione, non sul board. Il ciclo pesante dello stesso giro dichiarava «superstiti 21 contro 16
minimi = 1,3x». **Perché il ristretto scenda a 2 non è misurabile dallo stato salvato** — è la lacuna
di §5.2 p.10: i candidati scartati non sono persistiti da nessuna parte.

---

## B2 · I mercati esclusi a q=0,60

Su **tutto** il board (finanziabili e non), 14 esclusi, $1.217/g di montepremi. 12 su 14 hanno
`depth = 0`. Elenco completo con profondità, soglia, lordo e scarto in
`data/ricerca/taratura-profondita.json` → `esclusi60`.

**⚠ NON è nei log e non lo si poteva leggere: è RICALCOLATO.** §5.2 p.10 — i candidati scartati non
vengono persistiti (`realloc-ultimo-piano.json` tiene solo i vincitori, e l'esclusione vive in un
processo figlio). Qui si riapplica la stessa aritmetica del modulo vero ai due ingressi veri.
**Strumentazione mancante**: l'istogramma dei `reasonCode` scartati accanto a `righe` in
`data/realloc-ultimo-piano.json`.

**⚠ Il «lordo» è il MONTEPREMI DEL MERCATO, non ciò che incasseremmo**: la nostra quota va
moltiplicata, e su un book a profondità 0 la quota modellata è il 100% — che è esattamente ciò di cui
il filtro diffida.

---

## B3 · Il filtro ci protegge o ci affama? — VERDETTO: né l'uno né l'altro, è quasi inerte

### Cosa NON è misurabile, e va detto

- **Tasso di fill, costo di uscita, tempo di chiusura sui mercati ESCLUSI**: non esistono. Non ci
  abbiamo mai quotato. Un confronto diretto escluso-vs-ammesso sugli esiti **non è possibile**, e
  qualunque numero in quella colonna sarebbe inventato.
- **Reward maturati per dollaro PER MERCATO**: non è nei log e non può esserci — §4.12, il venue paga
  un bonifico **aggregato** e sulle righe REWARD `conditionId`/`title`/`slug` sono vuoti. Il
  consuntivo è per GIORNO. **Strumentazione mancante, e non colmabile lato bot.**

### Cosa È misurabile — dove sta il capitale, contro il verdetto del gate

22 posizioni, $131,45:

| verdetto del gate | posizioni | valore |
|---|---|---|
| **ammesso** | 13 | $73,35 |
| **escluso dalla profondità** | **1** | **$2,19** |
| **non finanziabile** (minSize 100) | 4 | $33,99 |
| non nel board / profondità ignota | 4 | $27,92 |

**Il capitale non è bloccato nei mercati sottili: $2,19 su $131,45 (1,7%).** È bloccato nei mercati
**non finanziabili** ($33,99, incluso `0xcd126ec4` — la posizione da 8,2 ore scoperta di §5-bis p.138,
minSize 100, depth 0) e nei mercati usciti dal board.

### Il danno vero — i residui — nasce sui book SPESSI

Registro `data/residui-scoperti.json`, 25 voci:

| verdetto del gate | residui |
|---|---|
| ammesso (book spesso) | **14** |
| escluso dalla profondità | 2 |
| non finanziabile | 4 |
| profondità ignota | 5 |

Le profondità dei mercati ammessi che hanno prodotto residui: 71,9 · 110,2 · 170,4 · 274,1 · 297 ·
317 · 397,5 · 447,7 · 546,1 · 1.298,7 share. **Non sono book sottili.**

Tasso base degli esclusi fra i finanziabili: 5/46 = **10,9%**. Quota di residui a profondità nota nati
in mercati esclusi: 2/16 = **12,5%**. **Nessuna differenza rilevabile — e su n=16 non sarebbe
rilevabile nemmeno se ci fosse.** Si dichiara il limite invece di concludere.

### Conclusione

**Il filtro non ci sta affamando** (toglie 5 mercati su 46 finanziabili, lasciandone 41 contro 16
necessari) **e non ci sta nemmeno proteggendo in modo misurabile** (i mercati che esclude sono quelli
a profondità 0, in cui non abbiamo capitale e da cui non provengono i nostri residui). **È quasi
inerte al margine.** La leva sul capitale fermo è altrove: il **pavimento premiante contro il tetto
per mercato**, che toglie 56 mercati su 102.

Coerente con §5-bis p.152, misurato indipendentemente: i nostri fill arrivano sul **mid fermo**
(82,4% dei casi) e non nelle raffiche, e il costo di un fill è $0,05/g contro $0,91/g di capitale
immobilizzato. **La selezione avversa da book sottile non si sta materializzando.**

---

## B6 · agent40 e agent41 usano DUE soglie diverse — e il rinnovo eredita il vizio già corretto

**Sono due regole diverse, in due moduli diversi, con due unità di misura diverse.**

| | agent41 / allocatore | agent40 / motore |
|---|---|---|
| funzione | `scalaProfondita` (`lib/rewards/profondita-minima.js:209`) | `pavimentoDepth` (`lib/maker/motore-unico.js:105`) |
| regola | quota modellata ≤ **q = 0,60** | profondità altrui in banda ≥ **10% della liquidità altrui media** di quel mercato |
| costante | `MAX_QUOTA_CREDIBILE` = `realistic-estimate.DEFAULTS.maxCredibleShare` | `DEPTH_FLOOR_PCT_OF_AVG = 0.10` (`motore-unico.js:59`), ripiego $15 |
| unità | **share** | **dollari** |
| quando | selezione del piano | ogni piazzamento e ogni rinnovo |

Non c'è nessuna costante condivisa e nessuna divergenza da correggere: **rispondono a due domande
diverse.** Il rifiuto di Austin viene dal **secondo**, non dal primo (`motore-unico.js:218`, il testo
esatto: «la banda finisce prima del pavimento: $43,12 su 1 livelli contro $186,44»); il primo
**ammette** Austin (minSize 20, depth ben sopra 13,3).

### 🔴 Il difetto — annotato, NON corretto in questa sessione

**`pavimentoDepth` non conosce la differenza fra aprire e rinnovare, ed è deliberato**:

- `lib/maker/motore-unico.js:105-146` — `pavimentoDepth` non riceve né `chiudePosizione` né alcun
  flag di chiusura;
- `lib/maker/motore-unico.js:208` — `if (cum + 1e-9 < pavimentoUsd) continue;` scarta il livello;
- `lib/maker/motore-unico.js:218` — il messaggio che ha ucciso la gamba di Austin;
- `lib/maker/tetto-chiusura.test.js:114-117` — un test **asserisce l'assenza**: «il pavimento di
  profondità non deve conoscere la chiusura». Quando §5-bis p.133 ha esentato le CHIUSURE dal tetto
  per mercato, il pavimento è stato lasciato fuori **di proposito**;
- `lib/maker/auto-reprice.js:1576` — il rinnovo passa lo stesso `pavimentoUsd` di un'apertura.

**È la stessa forma dei difetti chiusi stamattina** (§5-bis p.133 tetto per mercato sulle chiusure,
p.147 tetto per ordine sul riposizionamento scoperto): una regola nata per limitare l'**apertura** di
esposizione nuova, applicata a un'azione che **non apre nulla**.

**Il caso vero, con l'ora**: `cid_8951311347` (Austin), gamba **YES BUY 0,44 × 32,6 = $14,34** — una
delle due gambe di una coppia piazzata alle 12:30:06. Alle **13:13:13** il log di agent40 dice:

> `SCADUTO SENZA RINNOVO · YES BUY 0.44 x 32.6 · $14.34 tornati liberi · il rinnovo era DOVUTO e l'ha
> fermato «motore-non-conforme»: profondita-insufficiente: la banda finisce prima del pavimento:
> $43.12 su 1 livelli contro $186.44`

Da lì il mercato è rimasto **a gamba singola per oltre 5 ore** (1.180 righe `LATO SINGOLO · resta la
NO`, poi 224 `resta la YES`), cioè **esposizione direzionale prodotta da un filtro anti-rischio**.

**⚠ E l'analogia NON è perfetta — va detto.** L'esenzione sul tetto poggiava su una prova aritmetica:
un BUY limitato da `manca` può solo **appaiare**, mai aprire. Qui la prova non esiste nella stessa
forma: rinnovare una gamba a riposo su un book sottile **lascia davvero capitale a riposo su un book
sottile**, che è il rischio contro cui il pavimento esiste. Ma il termine di paragone non è «nessuna
esposizione»: è **«la gamba sorella muore e restiamo direzionali»**, che è l'esito misurato.

**Non implementato.** Serve una decisione dell'operatore su quale delle due esposizioni si preferisce,
e su quale prova renda l'esenzione sicura per costruzione — non un `if` aggiunto a occhio.

In 2 ore il motore ha rifiutato per `motore-non-conforme` **1.331 volte**: 976+184
`profondita-insufficiente`, 755+26 `tetto-mercato`, 543 `mai-primo-sul-libro`. **Quanti di quei 1.160
`profondita-insufficiente` fossero RINNOVI di gambe che coprivano una posizione, e quanti aperture
nuove, NON è nei log**: il record non porta un campo che distingua i due casi. *Strumentazione
mancante: un `chiudePosizione`/`rinnovo` booleano sul record di rifiuto del motore.*

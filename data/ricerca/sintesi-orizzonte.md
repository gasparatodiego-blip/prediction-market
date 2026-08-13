# Il filtro orizzonte — quanto costa `MIN_HORIZON_DAYS = 0,75`

Sessione di **sola misura**, 13 agosto 2026 sera. Nessuna soglia toccata, nessun processo riavviato,
nessun ordine. Script in `scripts/ricerca/`, dati in `data/ricerca/`.

| script | cosa misura | uscita |
|---|---|---|
| `orizzonte-popolazione.js` | la fascia sotto 18 h su 7 giorni di fotografie del board | `orizzonte-popolazione.json` |
| `orizzonte-sensibilita.js` | il **piano vero** con il pavimento sostituito in memoria | `sens-650-*.json` |
| `orizzonte-brevi-rischio.js` | i 21 maker + le nostre posizioni + i nostri residui | `orizzonte-brevi-rischio.json` |
| `orizzonte-maturazione.js` | campionamento del venue e soglia di pareggio | `orizzonte-maturazione.json` |

`orizzonte-sensibilita.js` **non riscrive nessun file**: sostituisce `horizonVerdict` nell'oggetto di
modulo dentro il proprio processo figlio, prima che l'allocatore lo destrutturi (`allocator.js:78`).
Tutto il resto della catena — curve, DP, scala sulla profondità, tetto di credibilità, quota della coda
lunga — è il codice di produzione.

---

## 1 · Quanto valgono i mercati scartati

**Sulla fotografia delle 20:17 del 13 agosto** (la stessa per tutte le righe della tabella §5):
78 dei 102 mercati valutati escono per orizzonte, e **63 di quei 78 hanno fra 12 e 18 ore di vita**.

**Su 7 giorni** (256 fotografie, `orizzonte-popolazione.json`): 1.011 mercati distinti toccano la
fascia corta, mediana **19 per fotografia** con escursione **0 → 95**.

- montepremi: mediana **$73/g**, Q1 $53, Q3 $110, max $7.500
- pavimento premiante: minSize `{20: 377, 50: 213, 100: 407, 200: 13, 500: 1}` ⇒ finanziabili al tetto
  **$32,67 → 377/1011**, $50 → 590, $61,25 → 590, $98 → 997
- banda: mediana **4,5¢**, identica a quella degli ammessi — la fascia corta non è più difficile da
  presidiare
- profondità (book totale): corti mediana **$200**, ammessi **$503** — i corti sono **più sottili**
- 450 dei 1.011 sono **nati corti** (mai visti sopra il pavimento): vita mediana **5,9 h**, Q3 10,5 h.
  I più ricchi sono i `Bitcoin Up or Down` a finestra di 15 minuti, $7.500/g nominali su **0,1 h** di
  vita — un tasso, non un importo (vedi §4)
- 561 hanno **solo la coda tagliata**: erano entrabili prima, mediana **11 h** sopra il pavimento

⚠ `montepremiGiorno` è un **tasso**. Sommare i montepremi della fascia corta ($230.760/g su 7 giorni)
non è un numero di ricavo e non va usato.

**Il numero che conta — lordo raggiungibile con $650 al tetto $32,67, stessa fotografia:**

| pavimento | lordo modellato | quota tagliata al 15% (prudente) |
|---|---|---|
| 0,75 g (oggi) | **$64,10/g** | $31,75/g |
| 0,50 g | **$347,68/g** | $173,51/g |

Il filtro lascia fuori **$283,58/g di lordo modellato** su questa fotografia. Il rapporto **5,4×** è
stabile sotto il taglio prudente delle quote (**5,5×**): è l'unico numero di questa misura che non
dipende dal credere alle quote alte.

**⚠ E varia di ora in ora.** Sulle 33 fotografie di oggi i mercati corti vanno da **2 (15:16)** a
**88 (18:18)**. Alle 15:48 il filtro non costava quasi niente; alle 20:17 costa 5,4×. Un piano
calcolato alle 16:00 e uno calcolato alle 20:00 vedono due board diversi.

---

## 2 · L'origine di `MIN_HORIZON_DAYS = 0,75`

**È documentata, ed è derivata da una misura** — commit `123d812`, 8 agosto 2026, con l'intestazione
di `lib/rewards/horizon.js` che la riporta per esteso.

Percorso: 2 g (assunzione «una posizione va chiusa») → **0,25 g** (mediana 0,22 g di *tutti* i 450
ingressi dei 21 maker) → **0,75 g**. La correzione: di quei 450 ingressi solo **40 (8,9%)** sono su
mercati dentro il programma premi; separando le popolazioni, orizzonte mediano **22,7 h sui premianti**
contro **2,2 h sui non premianti**.

18 h e non 21 perché fra **12,4 h e 19,6 h il campione premiante è VUOTO**: si è scelto il punto dove
la risposta è insensibile alla scelta.

**Tre limiti, tutti già dichiarati nel file o nel commit:**

1. Il file stesso chiude con «**resta dichiarato, non derivato — è un'assunzione**».
2. È calibrato su **cosa fanno i vincitori**, non su **cosa ci costa**. Nessuna misura di P&L,
   fill o residui è entrata nella scelta.
3. Il commit dichiara «**EFFETTO MISURATO: zero, oggi**» — il board dell'8 agosto aveva orizzonte
   minimo 1,17 g e nessun premiante fra 6 e 18 h. **Oggi la stessa soglia toglie il 76% del board.**
   La taratura non è stata rifatta da allora.

E il vuoto 12,4–19,6 h su cui poggia l'argomento di insensibilità **non esiste più**: oggi 63 mercati
stanno esattamente lì.

---

## 3 · I mercati brevi ci fanno male? — il verdetto

### I 21 maker: la risoluzione arriva prima dell'uscita?

1.563 coppie ingresso→ritiro appaiate, di cui **120 su mercati premianti**.

| bucket d'ingresso | casi | usciti DOPO la risoluzione | % | tenuta mediana |
|---|---|---|---|---|
| **sotto 6 h** | 37 | **13** | **35,1%** | 0,3 h |
| 6–12 h | 36 | **0** | **0%** | 6,6 h |
| 12–18 h | 15 | **0** | **0%** | 15,3 h |
| 18–48 h | 32 | **0** | **0%** | 22,9 h |
| non premianti (tutti) | 1.443 | 431 | 29,9% | 1,3 h |

**Il confine del rischio è a 6 ore, non a 18.** Fra 6 e 48 ore: zero casi su 83.

⚠ Regola del tre: 0/36 ammette fino a ~8%, 0/15 fino a ~18%. «Zero misurato» non è «zero vero», ma
la differenza col 35,1% sotto le 6 h resta di un ordine di grandezza.

### Noi: siamo già dentro la fascia che il filtro dovrebbe evitare

`nostro:` eredita i 4 giorni di presenza su 30.

- **22 gambe su 22 mercati. NUDE: 22. Coppie complete: 0.** Nozionale $138,80.
- Delle 17 con scadenza leggibile, **17 su 17 sono sotto le 18 ore** (tutte a 15,51 h: la famiglia
  meteo giornaliera). Zero sopra. 5 non sono più sul board.
- `modalita-chiusura.json`: 23 coppie tracciate, **18 con la gamba sorella mai piazzata**; età della
  coppia **mediana 9,5 h, massimo 23,8 h**.
- Residui: **25, di cui 21 sotto il minimo del venue**, $145,07 murati, frazione mediana del minimo
  **45%**. Su 25 mercati distinti: **18 sotto le 18 h, ZERO sopra**.

**Il filtro non impedisce di stare sui mercati brevi: impedisce di ENTRARCI.** Un mercato entra nel
piano a 20 h e invecchia sotto la soglia mentre lo teniamo. Il rischio «gamba nuda a risoluzione» lo
stiamo già correndo sul 100% del portafoglio, con una gamba nuda che dura in mediana 9,5 h su mercati
che ne hanno 15,5.

---

## 4 · Il reward si matura in tempo?

Il venue campiona **una volta al minuto, a caso — 1.440 campioni al giorno** (documentazione ufficiale
citata in `lib/maker/auto-reprice-config.js`). Un mercato che vive H ore offre 60·H campioni:
6 h → 360 (25% di una giornata), 12 h → 720 (50%), 15,5 h → 930 (65%).

Il maturato in tutta la vita è `montepremi × quota × H/24`. Contro il costo del giro — uscita a mercato
su due gambe, $0,333 al tetto di oggi (33,3 share per lato × bookSpread mediano 0,01):

| quota | $/g al tasso | ore per pareggiare l'uscita |
|---|---|---|
| 2% | $1,22 | 6,6 h |
| 5% | $3,05 | 2,6 h |
| 10% | $6,10 | 1,3 h |
| 15% | $9,15 | 0,9 h |

Alla quota mediana del piano a 12 h (~14%) **il costo di transazione rientra in meno di un'ora**. La
maturazione **non è il vincolo** sopra le 2-3 ore. Il vincolo è la gamba nuda che va a risoluzione, ed
è un rischio di varianza sul nozionale, non un costo di transazione.

---

## 5 · Sensibilità — $650, stessa fotografia del board (20:17:13)

| `MIN_HORIZON_DAYS` | ore | scartati per orizzonte | scartati per tetto | scelti | capitale | fermo | lordo/g | realistico/g | prudente (quota ≤15%) |
|---|---|---|---|---|---|---|---|---|---|
| 0,25 | 6 | 14 | 49 | **21** | $648 | $2 | $347,60 | $188,40 | ~$173 |
| 0,40 | 9,6 | 15 | 49 | **21** | $648 | $2 | $347,68 | $188,64 | $173,51 |
| **0,50** | **12** | **15** | **49** | **21** | **$648** | **$2** | **$347,68** | **$188,64** | **$173,51** |
| 0,75 (oggi) | 18 | **78** | 18 | **3** | $96 | **$554** | $64,10 | $42,06 | $31,75 |
| 1,00 | 24 | 79 | 18 | **2** | $64 | $586 | $15,56 | $12,35 | — |

**Il gradino è tutto fra 12 h e 18 h.** 0,25 / 0,40 / 0,50 danno lo stesso piano: il pianoro di
insensibilità oggi è **6–12 h**, e 18 h sta sull'altro lato del gradino.

Costo atteso della riga migliore (0,50 g, 21 mercati): 42 gambe nude potenziali, uscita a mercato
$0,333 per mercato ⇒ **~$7,00**; `f_min` 60% invariato (il tetto non cambia); gambe nude a risoluzione
**0% atteso** sul bucket 12–18 h dei 21 maker (0/15, limite superiore ~18%).

### La stessa riga a tetto diverso

| tetto | scelti | capitale | lordo/g | realistico/g | **prudente (quota ≤15%)** |
|---|---|---|---|---|---|
| $32,67 | 21 | $648 | $347,68 | $188,64 | **$173,51** |
| $50 | 15 | $648 | $358,36 | $208,94 | — |
| $98 | 11 | $648 | $370,42 | $232,67 | — |
| $245 | 9 | $650 | $439,57 | $271,08 | **$135,90** |

**Il vantaggio del tetto alto sparisce sotto il taglio prudente e si inverte**: a $245 il piano si
concentra su 9 righe con quote 24–60%, che è esattamente dove il modello è meno credibile.

---

## 6 · Verdetto

**Abbassare `MIN_HORIZON_DAYS` da 0,75 a 0,50 vale 5,4× sul lordo modellato** ($64,10 → $347,68/g) e
**5,5× sotto il taglio prudente** ($31,75 → $173,51/g). È l'unico rapporto di questa misura robusto
all'ipotesi sulle quote. Porta il capitale al lavoro da **$96 a $648** su $650.

**Il rischio nuovo introdotto è, misurato, zero** nella fascia 12–18 h: 0 uscite dopo la risoluzione su
15 casi premianti dei 21 maker (limite superiore ~18%). Il rischio vero sta **sotto le 6 ore** (35,1%),
e 0,50 g = 12 h lo lascia fuori con un fattore due di margine.

**Fra le due leve, a $650 l'orizzonte vale molto di più.** Sulla stessa fotografia:

| | tetto $32,67 | tetto $245 |
|---|---|---|
| **pavimento 0,75** | $64,10/g | $67,55/g (**+5%**) |
| **pavimento 0,50** | $347,68/g (**+442%**) | $439,57/g |

Il tetto da solo riempie il capitale ($96 → $650) e **non muove il lordo** (+5%): con 3 soli mercati
ammessi, il capitale in più finisce contro il tetto di credibilità. L'orizzonte da solo fa +442%.

**Vanno mosse una alla volta, e l'orizzonte per primo.** Il tetto è la leva sbagliata finché
l'universo è di 24 mercati: non c'è dove mettere il capitale. Con l'universo riaperto la leva del
tetto peggiora sotto il taglio prudente, quindi non va mossa insieme.

### Il filtro ci sta salvando da qualcosa?

**No, non da ciò che dichiara di evitare** — e questo è il punto più solido della misura. Il rischio
«gamba nuda a risoluzione» lo corriamo già sul 100% del portafoglio: tutte le 22 posizioni sono nude,
tutte sotto le 18 ore, tutti i 25 residui su mercati sotto le 18 ore. Il filtro agisce all'ingresso;
il rischio arriva dall'invecchiamento, che il filtro non tocca.

**Sì, da una cosa diversa da quella che dichiara:** con un pavimento a 6 h entrerebbero i `Bitcoin Up
or Down` a 15 minuti, dove il rischio misurato è **35,1%**. Quella protezione è reale — e la dà già
un pavimento a 12 h, con 24 mercati in più.

### Quello che questa misura NON dice

- Non dice che guadagneremmo $347/g. Metà di quel lordo viene da 3 righe con quota modellata 45–59%
  su book sottili — l'artefatto che `profondita-minima.js` esiste per contenere. La cifra difendibile
  è il **rapporto**, non il livello.
- Non dice niente sul tasso di fill nostro per orizzonte: non è stato misurato (servirebbe lo stream
  del giornale maker da 340 MB con il join tokenId→conditionId).
- Il campione dei 21 maker nella fascia 12–18 h è **15 casi**.
- I nostri numeri ereditano i **4 giorni di presenza su 30**.

# Su quali categorie di mercato entrano i 21 maker — e cosa vede il bot

**Data della ricerca:** 8 agosto 2026, ~19:00 UTC
**Stato del bot durante la ricerca:** KILL attivo dalle 17:20:17Z, zero posizioni aperte, zero ordini a
riposo, saldo pUSD $668,25. Nessun ordine è stato piazzato, cancellato o modificato.
**Riproducibile con:** `node scripts/ricerca-categorie-21.js --universo` (sola lettura)

---

## 0 · La domanda, e la risposta in una riga

La domanda era: *quali categorie di mercato scelgono sistematicamente i 21 wallet vincenti, e il board
del bot assomiglia a quello che fanno davvero?*

La risposta è che **la domanda va posta su un campione diverso da quello ovvio**. I 21 entrano
per il **77% su mercati sportivi** — ma **solo l'1,7% di quegli ingressi è su un mercato che paga
premi di liquidità**. Su 450 ingressi osservati, **40 (8,9%)** sono su mercati dentro il programma
premi. Il resto è un mestiere diverso da quello di questo bot: market-making direzionale su sport,
dove il ricavo è lo spread e non il premio.

Confrontare il board con il **77% sport** sarebbe quindi un errore di lettura. Il confronto giusto è
con i **40 ingressi premianti**, ed è quello che questo report fa — dichiarando ogni volta quale dei
due campioni sta usando.

---

## 1 · Metodologia

### Il campione

| | |
|---|---|
| Fonte | `data/maker-21-eventi.jsonl`, scritto da `agent42-watch-makers` |
| Ingressi | **450** (erano 299 alla ricerca precedente: **+151** in circa un giorno) |
| Periodo | 2026-08-07 11:54 UTC → 2026-08-08 18:57 UTC (**31,0 ore**) |
| Wallet distinti | **20** dei 21 sorvegliati |
| Mercati distinti | **441** |
| Famiglie distinte | **133** |
| Ingressi su mercati premianti | **40** (8,9%) |

Ogni riga porta già i metadati che servono: `titolo`, `slug`, `eventSlug`, `montepremiGiorno`, `banda`,
`oreAScadenza`, `affollamento`, `primoFill`, `nelProgrammaPremi`. Non è servito recuperare niente.

**Nota sulla dimensione.** 450 ingressi bastano per la distribuzione complessiva; **40 non bastano per
una statistica solida per categoria** dentro il sottoinsieme premiante. Le percentuali del sottoinsieme
vanno lette come ordini di grandezza, non come stime puntuali — e sono trattate così in tutto il report.

### Il classificatore

`lib/rewards/categoria-mercato.js` (nuovo, **sola lettura, non importato da nessun percorso vivo**).
Otto categorie: `crypto`, `sport`, `meteo`, `politica-elezioni`, `politica-nomine-locali`,
`cronaca-eventi`, `finanza-aziende`, `altro`.

Tre scelte che contano:

1. **Si classifica sullo slug, non sul titolo.** Polymarket costruisce gli slug con un prefisso
   strutturato — `efl-bro-rea-2026-08-08`, `btc-updown-5m-1786214100`,
   `highest-temperature-in-singapore-on-august-8-2026-32c` — mentre il titolo è prosa e cambia forma
   («Will X win on…», «O/U 3.5», «Exact Score…») per lo stesso evento. Il titolo resta come seconda passata.

2. **Una regola sulla FORMA batte una lista di prefissi.** Alla prima passata, 20 dei 25 mercati finiti
   in `altro` erano campionati di calcio con un codice non previsto (`chi1`, `chi2`, `bol1`, `clf`,
   `swe2`, `fr2`, `uru1`, `ecu1`, `fin1`, `bra2`, `slo`, `lal`). La regola
   `<lega>-<casa>-<ospite>-<AAAA-MM-GG>` li prende tutti, compresi quelli che nasceranno domani.

3. **`altro` è un esito dichiarato, non un cestino.** Ogni classificazione porta il motivo, e i mercati
   non classificati vengono elencati con il loro slug. **Risultato finale: 0 su 450 e 0 su 112.**

**Accuratezza misurata, non assunta.** Il board porta il campo `category` di Gamma, che il
classificatore non legge. Sui 95 mercati del board che hanno un valore Gamma utilizzabile, l'accordo è
**95/95 = 100%**. Due errori trovati proprio da questo confronto e corretti: la regola sui premi
sportivi prendeva qualunque `-winner-AAAA` (e quindi `presidential-election-winner-2028`), e la regola
di geopolitica prendeva qualunque `will-the-us-…` (e quindi «Will the US confirm that aliens exist»).

---

## 2 · Fase 1 — Distribuzione per categoria

| categoria | 21 · tutti (450) | 21 · **premianti** (40) | board bot (112) |
|---|---|---|---|
| sport | **345 · 77,0%** | 6 · 15,0% | 10 · 8,9% |
| crypto | 44 · 9,8% | 3 · 7,5% | — |
| finanza-aziende | 30 · 6,7% | **11 · 27,5%** | 7 · 6,3% |
| cronaca-eventi | 17 · 3,8% | **10 · 25,0%** | 14 · 12,5% |
| meteo | 9 · 2,0% | 7 · 17,5% | **44 · 39,3%** |
| politica-elezioni | 3 · 0,7% | 3 · 7,5% | 24 · 21,4% |
| politica-nomine-locali | — | — | 13 · 11,6% |
| altro | — | — | — |

### Il tasso di mercati premianti dentro ogni categoria — la tabella che riorienta tutto

| categoria | premianti / ingressi | tasso |
|---|---|---|
| politica-elezioni | 3/3 | **100,0%** |
| meteo | 7/9 | **77,8%** |
| cronaca-eventi | 10/17 | **58,8%** |
| finanza-aziende | 11/30 | **36,7%** |
| crypto | 3/44 | 6,8% |
| sport | 6/345 | **1,7%** |

Lo sport è il **77% della loro attività e l'1,7% della loro attività premiante**. Il meteo è il 2% della
loro attività e il 78% di quel 2% paga. Sono due popolazioni diverse dentro lo stesso campione, e
mescolarle produce una media che non descrive nessuna delle due.

### Correlazioni con le altre misure

| categoria | nozionale mediano | ore alla scadenza (mediana) | affollamento mediano | montepremi mediano |
|---|---|---|---|---|
| crypto | $5,00 | **0,1** | **101** | $10.000 |
| sport | $19,20 | 2,5 | 11 | $4 |
| finanza-aziende | $13,02 | 6,4 | 3 | $20 |
| meteo | $20,60 | 20,4 | 87 | $24 |
| cronaca-eventi | $8,21 | 159,2 | 40 | $50 |
| politica-elezioni | $10,00 | 2.104,3 | 23 | $1 |

**Il pattern più importante, ed è di orizzonte:**

> orizzonte mediano · ingressi **premianti 21,4 h** · ingressi **NON premianti 2,2 h**

I 21 entrano su mercati premianti con un orizzonte **dieci volte più lungo** di quello con cui entrano
sui mercati non premianti. Ha senso: un premio di liquidità si matura restando sul libro, e su un
mercato che scade fra due ore non c'è tempo per maturarlo.

**Questo ha una conseguenza diretta su una costante viva del bot.** `MIN_HORIZON_DAYS = 0,25` (6 ore) è
stato tarato sulla mediana di **0,22 giorni ≈ 5,3 ore** dei fill dei 21 — cioè sulla popolazione
NON premiante. La mediana della popolazione che conta per un bot di liquidity rewards è **21,4 ore
(0,89 giorni)**. Vedi §5, raccomandazione R3: **non è stata applicata**, perché tocca l'allocazione di
capitale reale.

Altri pattern:
- **crypto = affollamento 101 e nozionale $5.** È il posto più affollato del campione e quello dove i
  21 mettono meno soldi: 44 ingressi con una mediana di cinque dollari. Non è dove costruiscono
  posizione, è dove fanno volume.
- **finanza-aziende = affollamento 3.** Il posto meno affollato, con il 36,7% di mercati premianti.
  È il profilo opposto al crypto.
- **meteo = nozionale $20,60 con punte a $182.** È l'unica categoria dove i 21 mettono size vera *e*
  il tasso di premianti è alto.

---

## 3 · Fase 2 — Dentro le categorie, e la ripetizione

### 3.1 · Dentro sport (345 ingressi)

| tipo di mercato | n | % |
|---|---|---|
| linea principale (1X2 / vincente) | 224 | **64,9%** |
| derivato: O/U, spread, BTTS | 67 | 19,4% |
| derivato: primo a segnare | 27 | 7,8% |
| derivato: risultato esatto | 13 | 3,8% |
| derivato: primo tempo | 11 | 3,2% |
| derivato: calci d'angolo | 3 | 0,9% |

Due terzi sulla linea principale, un terzo sui derivati. Nessuna preferenza per un campionato «ricco»:
il campione contiene EFL inglese, Serie B tedesca, campionati cinese, giapponese, argentino, rumeno,
estone, lettone, lituano, kazako, peruviano, croato, sloveno, boliviano, uruguaiano, ecuadoriano. La
selezione sembra guidata dall'**orario** (cosa gioca adesso) più che dalla lega.

### 3.2 · Dentro crypto (44 ingressi)

| forma | n | % |
|---|---|---|
| **BTC finestra 5 minuti** | 36 | **81,8%** |
| altre forme (soglie giornaliere) | 6 | 13,6% |
| ETH finestra 5 minuti | 2 | 4,5% |

**I 5 minuti sono davvero il taglio preferito, e non ci sono finestre alternative nel campione** (nessun
15 minuti, nessuna oraria). Ma solo **3 ingressi su 44 sono su un mercato che paga**: il resto ha
`montepremi 0`. Il crypto a 5 minuti, per i 21, è quasi interamente attività non premiante.

### 3.3 · La ripetizione — sì, ed è forte

| | |
|---|---|
| famiglie distinte | **133** su 450 ingressi e 441 mercati distinti |
| copertura delle prime **10** famiglie | **201 ingressi = 44,9%** |
| copertura delle prime **20** famiglie | **270 ingressi = 60,3%** |

| ingressi | mercati | wallet | categoria | tipo | famiglia |
|---|---|---|---|---|---|
| 39 | 39 | 3 | sport | lega ricorrente | `efl` |
| 36 | 35 | 2 | crypto | finestra ricorrente | `btc-updown-5m` |
| 20 | 20 | 3 | sport | lega ricorrente | `lol` |
| 19 | 18 | 2 | sport | lega ricorrente | `chi` |
| 17 | 17 | 2 | sport | lega ricorrente | `jap` |
| 17 | 17 | 3 | sport | lega ricorrente | `bl2` |
| 14 | 14 | 2 | sport | lega ricorrente | `lec` |
| 14 | 12 | 3 | sport | lega ricorrente | `atp` |
| 13 | 13 | 2 | sport | lega ricorrente | `arg` |
| 12 | 12 | 2 | sport | lega ricorrente | `por` |

**441 mercati distinti su 133 famiglie**: ogni famiglia produce in media 3,3 mercati diversi, e nessun
mercato viene ripreso due volte. Non tornano sullo *stesso mercato*: tornano sulla stessa **serie**.
`btc-updown-5m` è il caso estremo — 36 ingressi su 35 mercati distinti, cioè una finestra dopo l'altra.

**Implicazione operativa, e vale anche per il bot:** una watchlist di **20 famiglie** coprirebbe il
60% della loro attività. Il bot oggi riscopre l'universo da zero a ogni ciclo di 15 minuti.

**Ma per il sottoinsieme premiante la ripetizione quasi sparisce**: le famiglie premianti ricorrenti
sono solo `btc-updown-5m` (3), `what-will-trump-say-during-friday-roundtable` (3), `dota2` (4) e le
serie meteo per città (2 su Singapore, 2 su Shanghai). Tutte le altre 25 famiglie premianti hanno un
solo ingresso. **La watchlist aiuterebbe l'attività non premiante molto più di quella premiante.**

---

## 4 · Fase 3 — Confronto con il board, e le cause

### 4.1 · Lo scarto

Soglia proposta per «significativo»: **±10 punti percentuali**. Motivazione: con n = 40 nel campione
premiante, un singolo ingresso vale 2,5 punti; ±10 punti sono quattro ingressi, cioè un margine che
non si sposta per rumore campionario di uno o due eventi.

| categoria | board − 21(premianti) | verdetto |
|---|---|---|
| meteo | **+21,8** | sovra-rappresentata |
| politica-elezioni | **+13,9** | sovra-rappresentata |
| politica-nomine-locali | **+11,6** | sovra-rappresentata |
| crypto | −7,5 | sotto, non significativo |
| sport | −6,1 | sotto, non significativo |
| cronaca-eventi | **−12,5** | sotto-rappresentata |
| finanza-aziende | **−21,3** | sotto-rappresentata |

### 4.2 · La terza colonna, che cambia il verdetto

Uno scarto contro i 21 non dice se il board possa fare diversamente. Serve sapere **cosa esiste**.
Sweep dell'universo premiante 0→48 ore su Gamma (sola lettura, 8 fette da 6 ore, paginazione a 100):

| categoria | universo premiante 48h (217) | board (112) | 21 premianti (40) |
|---|---|---|---|
| meteo | **159 · 73,3%** | 44 · 39,3% | 7 · 17,5% |
| cronaca-eventi | 41 · 18,9% | 14 · 12,5% | 10 · 25,0% |
| sport | 7 · 3,2% | 10 · 8,9% | 6 · 15,0% |
| politica-nomine-locali | 3 · 1,4% | 13 · 11,6% | — |
| finanza-aziende | **1 · 0,5%** | 7 · 6,3% | 11 · 27,5% |
| politica-elezioni | — | 24 · 21,4% | 3 · 7,5% |
| crypto | **— (zero)** | — | 3 · 7,5% |

Distribuzione temporale dei 217 premianti: **13 sotto le 6 ore · 46 fra 6 e 36 ore · 158 oltre 36 ore.**

### 4.3 · Le cause, una per una

**meteo (+21,8) — NON è una sovra-rappresentazione del board: è una sotto-rappresentazione.**
Il board è al 39,3% mentre l'universo premiante è al 73,3%. Il board contiene *meno* meteo di quanto
ce ne sia, perché `MAX_CLOB_MARKETS` ne tiene 120 ordinati per montepremi. Rispetto ai 21 sembra
troppo; rispetto a ciò che Polymarket paga, è già una selezione. **Nessuna azione.**

**finanza-aziende (−21,3) — causa STRUTTURALE, ma con un dettaglio azionabile.**
Nell'universo premiante 0→48h esiste **un solo** mercato di finanza. Ma gli 11 ingressi premianti dei
21 sono concentrati in due forme precise:

| forma | esempi osservati | montepremi | ore alla scadenza |
|---|---|---|---|
| `<ticker>-up-or-down-on-<data>` | `spy` $200, `wti` $200, `amzn`/`tsla`/`meta`/`aapl` $20 | $20–200 | **2,6–8,0** |
| `what-price-will-<ticker>-hit-in-<mese>` | `meta` $10, `wti` $100, `abnb` $1, `hood` $10 | $1–100 | 570–590 |

Tutti gli ingressi `-up-or-down` sono del **7 agosto (venerdì) fra le 13:00 e le 17:24 UTC**, cioè
9:00–13:20 ET: **è una serie intraday che esiste nei giorni di borsa**. La verifica diretta su Gamma
oggi (sabato 19:00 UTC) trova **zero** eventi `spy-up-or-down`, `aapl-up-or-down`, `wti-up-or-down`.
La sweep non poteva vederli, e nemmeno agent24 può, oggi.

Il punto azionabile è un altro: quelle scadenze stanno a **2,6–8,0 ore**, cioè a cavallo del pavimento
`MIN_HORIZON_DAYS = 0,25` (6 ore). **Circa metà di questa famiglia cadrebbe sotto il pavimento anche
nei giorni in cui esiste.** Il board oggi ha 7 mercati di finanza, tutti oltre i 122 giorni: sono la
seconda forma (`what-price-will-…-hit`), non la prima. **Questa famiglia il bot non l'ha mai vista.**

**crypto (−7,5) — causa STRUTTURALE, e la spiegazione in CLAUDE.md va corretta.**
CLAUDE.md §5 punto 23 attribuisce l'assenza dei crypto 5-min al pavimento dell'orizzonte. La misura dice
qualcosa di più semplice e più forte: **nell'universo premiante delle prossime 48 ore i mercati crypto
sono ZERO**, e nel campione dei 21 solo **3 ingressi su 44** erano su un mercato che paga. I 35
`btc-updown-5m` restanti hanno `montepremi 0`. Anche togliendo il pavimento, non c'è niente da prendere.

Un dettaglio da registrare: i 3 premianti riportano `montepremiGiorno: 10.000`, e il record Gamma di uno
di essi (`btc-updown-5m-1786214100`) mostra `rewardsDailyRate: 10000` con `startDate 2026-08-08` ed
`endDate 2500-12-31`, ma `rewardsMaxSpread: 0` e `rewardsMinSize: 0`. Un montepremi da $10.000/giorno
**senza banda pubblicata**: la formula del venue `S(v,s)=((v−s)/v)²` è indefinita con `v = 0`, e
`agent24-liquidity-rewards.js:190` (`if (!maxSpread || maxSpread <= 0) continue`) lo scarta
correttamente. Il filtro fa la cosa giusta; il dato di Gamma è anomalo.
*(Sulla sweep 0→48h di oggi, quel filtro non ha scartato nulla: 217 premianti, 217 con banda.)*

**politica-elezioni (+13,9) e politica-nomine-locali (+11,6) — il board le prende perché esistono
e pagano.** 24 + 13 = 37 mercati su 112, con montepremi mediani di $30 e $50. Nell'universo 0→48h ce ne
sono solo 3, perché le corse elettorali scadono **oltre** le 48 ore: il board le pesca dalla passata sul
listino generale. I 21 ne fanno poco (3 ingressi), ma quei 3 sono **100% premianti**. Non è un errore
del board: è una categoria che paga e che i 21 usano poco perché il loro mestiere principale è altro.

**cronaca-eventi (−12,5) — il solo scarto dove il board può realisticamente muoversi.**
L'universo premiante 0→48h ne ha **41 (18,9%)**, il board ne prende **14 (12,5%)**, i 21 premianti ne
fanno **25,0%**. È l'unica categoria in cui tutti e tre i numeri dicono la stessa cosa: c'è offerta, i
21 la usano, il board la sotto-pesa. Le forme sono `will-<parola>-be-in-the-headlines-this-week`,
`what-will-<persona>-say-during-<evento>` e i conteggi di eventi.

---

## 5 · Fase 4 — Raccomandazioni

Nessuna raccomandazione che tocchi pesi, punteggi o filtri è stata applicata. **Il codice del motore di
selezione e della scoperta non è stato modificato in questa sessione.** Vedi §6 per cosa è stato
aggiunto (solo strumenti di misura).

### R1 — Alzare il pavimento dell'orizzonte da 6 ore a ~18-21 ore · **priorità ALTA · DA DECIDERE**

**Il dato.** Orizzonte mediano degli ingressi **premianti**: 21,4 ore. Degli ingressi non premianti:
2,2 ore. `MIN_HORIZON_DAYS = 0,25` (6 ore) è tarato sulla mediana 0,22 g dell'insieme completo, che è
dominato al 91% da mercati che non pagano premi.

**Perché non l'ho applicata.** Cambia quali mercati entrano nel piano, quindi dove va il capitale reale.
È esattamente il caso che la Fase 4 dice di non toccare da soli.

**Cosa guardare prima di decidere.** n = 40 è piccolo. La misura si rifà da sola fra qualche giorno con
`node scripts/ricerca-categorie-21.js`: se con 150-200 ingressi premianti la mediana resta sopra le 18
ore, il pavimento a 6 ore sta ammettendo una fascia che i vincitori non usano. **Il rischio di alzarlo
è concreto e va detto:** taglierebbe fuori la famiglia `<ticker>-up-or-down` di R2, che sta a 2,6–8 ore.
Le due raccomandazioni sono in tensione e vanno decise insieme.

### R2 — Watchlist di famiglie ricorrenti, a partire da `<ticker>-up-or-down` · **priorità MEDIA · DA DECIDERE**

**Il dato.** 20 famiglie coprono il 60,3% degli ingressi. La famiglia `<ticker>-up-or-down-on-<data>`
paga $20–200/giorno, ha affollamento mediano **3** (il più basso del campione) e il bot non l'ha mai
vista. Esiste solo nei giorni di borsa e per poche ore.

**La forma che suggerisco.** Non un peso nel punteggio, ma un elenco di famiglie note che la scoperta
interroga **per slug** oltre alle fette temporali — lo stesso principio della seconda passata di agent24
(§5 punto 23 di CLAUDE.md): le fette non le trovano perché ci sono in poche ore del giorno, non perché
un filtro le escluda. È additivo e non toglie niente a ciò che già funziona.

**Perché non l'ho applicata.** È un allargamento della scoperta, quindi a basso rischio in sé — ma
porterebbe nel piano una famiglia a orizzonte 2,6–8 ore che oggi il pavimento taglia a metà. Applicarla
senza decidere R1 significherebbe scoprire mercati che il filtro successivo scarta: lavoro sprecato e
un board che promette più di quanto il motore possa usare.

### R3 — Non inseguire il crypto · **priorità ALTA (come non-azione) · nessuna modifica**

Zero mercati crypto premianti nelle prossime 48 ore; 3 su 44 nel campione dei 21, con banda non
pubblicata. **Il pavimento dell'orizzonte non è la ragione per cui il bot non fa crypto**, e abbassarlo
per prenderli non produrrebbe niente. Correggere la spiegazione in CLAUDE.md §5 punto 23 (fatto: vedi §6).

### R4 — Cronaca-eventi merita più peso · **priorità MEDIA · DA DECIDERE**

L'unico scarto dove offerta, comportamento dei 21 e board concordano tutti nella stessa direzione:
offerta 18,9%, i 21 al 25,0%, board al 12,5%. Con montepremi fino a $200 e orizzonti fra 4 e 24 ore,
è la categoria più vicina all'archetipo di un maker premiante. **Tocca il punteggio di selezione:
decisione dell'operatore.**

### R5 — Meteo: lasciare com'è · **nessuna azione**

Sembra sovra-pesato del +21,8 rispetto ai 21, ma è **sotto**-pesato del −34 rispetto a ciò che esiste.
È la categoria con più offerta premiante (73,3%), i 21 la usano con il nozionale più alto del campione
($20,60 mediano, punte a $182) e il 77,8% dei loro ingressi meteo paga. Il board sta facendo bene.

### Riepilogo

| # | raccomandazione | priorità | stato |
|---|---|---|---|
| R1 | pavimento orizzonte 6h → ~18-21h | ALTA | **da decidere** — tocca l'allocazione |
| R2 | watchlist di famiglie (`<ticker>-up-or-down`) | MEDIA | **da decidere** — in tensione con R1 |
| R3 | non inseguire il crypto | ALTA | **nessuna modifica necessaria** |
| R4 | più peso a cronaca-eventi | MEDIA | **da decidere** — tocca il punteggio |
| R5 | meteo: lasciare com'è | — | **nessuna azione** |

---

## 6 · Cosa è stato aggiunto — e cosa NON è stato toccato

**Aggiunto (solo misura, nessun effetto sul bot vivo):**

| file | cosa |
|---|---|
| `lib/rewards/categoria-mercato.js` | il classificatore. Puro, sola lettura, **nessun modulo di `lib/`, `agents/` o `app/` lo importa** — un test lo verifica camminando l'albero dei sorgenti |
| `lib/rewards/categoria-mercato.test.js` | 41 asserzioni: casi nominali, famiglie, copertura misurata sui due corpus, accordo con Gamma, e la prova che non è cablato in nessun percorso vivo |
| `scripts/ricerca-categorie-21.js` | rifà l'intera analisi. `--universo` interroga anche Gamma (API pubblica, senza credenziali) |
| `data/ricerca-categorie-21-wallet.md` | questo report |

**NON toccato:** `MIN_HORIZON_DAYS`, `lib/rewards/horizon.js`, `lib/rewards/allocator.js`,
`agents/agent24-liquidity-rewards.js`, il motore unico, i pesi del knapsack. Nessun peso di categoria è
stato introdotto in nessun punto del percorso di selezione.

**Corretto in CLAUDE.md:** §5 punto 23 attribuiva l'assenza dei crypto 5-min al solo pavimento
dell'orizzonte. La misura dice che l'universo premiante crypto è vuoto: la spiegazione è stata
riscritta con il dato.

---

## 7 · Limiti dichiarati

1. **n = 40 sul sottoinsieme premiante.** Ogni percentuale della colonna «21 · premianti» ha una
   granularità di 2,5 punti. Le conclusioni sono direzionali.
2. **31 ore di osservazione**, e comprendono un venerdì e un sabato. La famiglia `<ticker>-up-or-down`
   esiste solo nei giorni di borsa: un campione che coprisse una settimana intera la peserebbe diversamente.
3. **La sweep dell'universo copre 0→48 ore.** Le categorie a orizzonte lungo (politica-elezioni) sono
   sistematicamente sottostimate in quella colonna. Il confronto board↔21 non ne risente; il confronto
   universo↔board sì, ed è dichiarato dove conta.
4. **4 fette su 8 hanno toccato il tetto dei 2.100 record di Gamma.** La copertura dell'universo è
   parziale, esattamente come lo è per agent24 (CLAUDE.md §5 punto 23).
5. **`nelProgrammaPremi` viene da Gamma via agent42** e vale `clobRewards.length > 0`. Su 450 ingressi:
   40 `true`, 409 `false`, 1 assente — copertura del 99,8%, quindi il dato non è viziato da letture mancate.

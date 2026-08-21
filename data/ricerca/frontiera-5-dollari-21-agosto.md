# Esiste una configurazione che rende $5/giorno? — referto, 21 agosto 2026

**Sola lettura.** Niente commit di codice operativo, nessun riavvio, nessuna modifica di
configurazione, nessun ordine toccato. Scritture solo in `scripts/ricerca/` e `data/ricerca/`.

## 0 · Formula usata, dichiarata

| cosa | funzione |
|---|---|
| banda `v` | `lib/banda-premiante.raggioBandaCents` — **v = maxSpread**, non maxSpread/2 |
| costo coppia | `lib/rewards/size-da-capitale.costoCoppiaAllaDistanza` — `1 − 2d`, la SSOT di `ef6be4d` |
| Q concorrenti | `lib/rewardScore.scoreBook` (libro vero) e `recoverCompetitorQ` (inversa esatta dei `levels`) |
| quota | `lib/rewardScore.quadraticUserShare` — `S(v,s)=((v−s)/v)²`, `qMin` con c=3 |
| **prezzo** | **`lib/maker/top-of-book.planBehindBest`**, la stessa del piazzamento, via lo schema di `quotabilita.js:58-62` |
| tetto di credibilità | 0,60, la regola di `realistic-estimate` (`maxCredibleShare`) |

**`realistic-estimate.js:269` NON è stato usato** — ma è **corretto**, verificato: `1a8e89a` lo fa
passare da `(C/2)/mid` a `sharePerLato(capitale, pairCost)`. E agent24 è ripartito alle **10:36:35**,
dopo `ef6be4d` (10:34:43): il board delle 14:00 porta già il denominatore giusto. Verificato che
`git diff ef6be4d..HEAD -- lib/rewardScore.js` sia **numericamente identico** (sola delega alla SSOT).

## 1 · Premesse del prompt, verificate

| premessa | esito |
|---|---|
| distanza reale 2,5¢ | ✅ **confermata** — pairCost 0,95 su 4 mercati (0,96 sul quinto), da `_leggi-ordini-vivi` |
| saldo ~$1.495 | ✅ **$1.494,78**, posizioni **0** |
| cap $650 · tetto $61,25 · ordine $80 · MERCATI=5 · CODA_LUNGA 0,5 | ✅ tutti confermati da `/proc` e `data/safety-risk-limits.json` |
| guardiano a −3,573% con $22,12 di margine | ✅ **−3,573%**, margine **$22,11** (rif. $1.550,17633) |
| capitale a libro ~$214 | ⚠️ **$268,46** — 10 ordini, 5 mercati, 56,5 share/lato. $214,70 sono **quattro** mercati su cinque |
| «premio reale incassato $0,09 il 21/08» | ❌ **NO.** $0,09 è la **stima** di oggi, non un incasso |

**I pagamenti REWARD veri** (data-api, funder `0x4C81…`, `type=REWARD`):

| pagato il | $ | pagato il | $ | pagato il | $ |
|---|---|---|---|---|---|
| 21/08 | **4,9455** | 14/08 | 17,702 | 09/08 | 3,6792 |
| 17/08 | 2,183 | 13/08 | 1,6628 | 07/08 | 1,3042 |
| 15/08 | **6,9782** | 11/08 | 4,2525 | | |
| 10/08 | **8,3524** | | | **totale** | **$51,06** |

**$5/giorno è già stato superato tre volte** (10/08 $8,35 · 15/08 $6,98 · 21/08 $4,95). La domanda
non è «è possibile», è «è ripetibile».

---

## 2 · IL CAP DEL BOARD — è questo il vincolo che pesa più di tutti

**Dove è scritto:** `agents/agent24-liquidity-rewards.js:71-72`
```js
const MAX_CLOB_MARKETS = Number(process.env.REWARD_MAX_CLOB_MARKETS) > 0
  ? Number(process.env.REWARD_MAX_CLOB_MARKETS) : 150;
```
**Dove morde:** `:678` — `return scelti.slice(0, MAX_CLOB_MARKETS)`, dopo la quota di metà posti ai
`minSize ≤ 100` (`:656`, `:670`).

**Perché 150** (righe 73-91, cronologia in commento): la fase di profondità chiama
`/book?token_id=` **uno alla volta**, misurati **2,7-3,9 s/mercato**; `150 × 2,7 s ≈ 6,8 min` più ~3
min di scoperta ≈ 10 min, dentro il periodo di 15 e sotto `ETA_BOARD_MAX_MS` (25 min) di agent41.
La scansione delle 14:00 lo conferma: `scanDurationMs: 544.858` = **9,08 min** per 150 mercati.

**Perché il board ha 108 e non 150:** `meta.suppressedThinDepth = 42`.

### Quanti mercati non vede

| | n | pool/giorno |
|---|---|---|
| mercati premianti VERI (censimento Gamma, 682 pagine, `universo-premiante.json`) | **1.813** | — |
| di cui **passano i nostri cancelli** (scadenza ≥ 24 h, `minSize ≤ 50`) | **1.556** | **$15.135** |
| di questi, **visti dal board** | **22** | $745 |
| **non visti** | **1.534** | **$14.390** |

Il giornale di agent41 lo dice dal suo lato, alle 14:38: `ammissibili: 21` su `valutati: 110`.
**Il bot sceglie fra l'1,4% dell'universo che gli è ammissibile.**

### La concorrenza sui non visti — misurata, non stimata

Scaricati **3.112 libri** (i due token di tutti e 1.556 gli ammissibili) e valutati col **prezzo vero
di `planBehindBest`** a $61,25 per mercato (`concorrenza-non-vista.json`, `frontiera-onesta.json`).
Esiti: `ok 1.020` · `libro-senza-concorrenza-misurata 474` · `non-quotabile 46` · `punteggio-zero 11`.

**I 20 migliori a $61,25 ciascuno:**

| premio/g | rate | cQ | quota | dBid | spread | visto? | mercato |
|---|---|---|---|---|---|---|---|
| $64,34 | $122 | 16,3 | 52,7% | 2,1¢ | 4,0¢ | **no** | Brazil Q2 2026 GDP growth (QoQ) |
| $32,48 | $78 | 17,9 | 41,6% | 2,5¢ | 4,8¢ | **no** | Brazil Q2 2026 GDP growth (QoQ) |
| $30,00 | $50 | 2,1 | 60,0% | 4,5¢ | 5,0¢ | **no** | Andy Burnham say "Speaker" 10+ |
| $26,98 | $50 | 16,6 | 54,0% | 1,0¢ | 1,0¢ | **no** | Israel military action vs Syria |
| $23,15 | $50 | 8,4 | 46,3% | 3,0¢ | 4,0¢ | **no** | Sprinklr (CXM) beat earnings |
| … | | | | | | | |

**Somma dei 20 migliori: $415,53/giorno su $1.225 di capitale. Tutti e 20 invisibili al board (20/20).**
223 mercati superano $1/giorno; 767 superano $0,10/giorno. **I 5 che teniamo, insieme, fanno $0,339.**

### ⚠ Il tetto di 150 è un artefatto del ciclo, non un limite del venue

`POST https://clob.polymarket.com/books` esiste, è **pubblico**, e accetta una lista di token:
verificato 200 OK, **3.112 libri in ~40 s con lotti da 40**. agent24 non lo usa. Alla stessa
latenza, i 1.813 premianti costerebbero **~25 s** invece di ~90 minuti.
**Non è una proposta di modifica — è la constatazione che la ragione dichiarata del tetto
(«2,7 s per mercato») descrive il metodo attuale, non il venue.**

---

## 3 · L'OOM DEL PIANO — reale, ma NON è lui a bloccare la selezione

**Quante volte:** il ciclo pesante gira ogni 6 h (03/09/15/21 UTC) e **fallisce tutte le volte**.
Record di fallimento per giorno in `data/realloc-scheduler.jsonl`: **19/08 → 3 · 20/08 → 12 ·
21/08 → 10** (3 record per occorrenza ⇒ 4 cicli/giorno, cioè il 100%).
**Da quando:** `data/realloc-ultimo-piano.json` è fermo al **19/08 15:25** — **47 ore** senza un piano
pesante salvato. 8 occorrenze di `heap out of memory` nel log di agent41.

**Come muore:** `FATAL ERROR: Ineffective mark-compacts near heap limit` a **924 MB** di heap, su una
macchina con **1.855 MB totali e 604 MB disponibili**. Il secondo modo è un **`timeout 120000ms`**.

**Cosa succede al piano: fallisce RUMOROSAMENTE, e poi si prosegue.** È scritto nel giornale e nel
log pm2 (`lastAzione:"nessuna"`, `lastMotivo:"…il confronto di valore non è stato misurabile…"`), ma
nessuna difesa reagisce, il bot non va su FERMA e il ciclo prosegue. Conseguenze misurate:
1. il **trigger di VALORE** del ciclo 6 h non è mai misurabile;
2. **`ripristinaGamba` non trova la riga**: «nessuna riga nel piano salvato, e il piano fresco non è
   disponibile» — cioè la copertura continua di §4.13 p.171 è **inerte** quando serve;
3. il piano salvato che il bot usa come memoria ha **47 ore**.

**⚠ CORREZIONE A UNA MIA CONCLUSIONE INTERMEDIA.** Stavo per scrivere che l'OOM svuota anche i netti
della selezione. **È falso, e la misura lo esclude:** su **3.430** record di selezione il campo
`nettiIniettati` è `null` **una volta sola (0,0%)**, e l'ultimo dice `nettiIniettati: 8`. Il motivo è
che i netti nascono da un figlio **diverso e piccolo** (`onlyMarketIds: ammissibili`, ~16-21 mercati,
`agent41:1348-1351`), mentre a morire è il piano **sull'intero board**.

**Compromette le misure del punto 1?** **No.** Il punto 1 non usa nessun output del pianificatore:
usa il board di agent24 (scritto alle 14:00, indipendente da agent41), il censimento Gamma e i libri
letti direttamente dal CLOB. L'OOM tocca *cosa il bot decide*, non *cosa io ho misurato*.

---

## 4 · IL DIVARIO — 30×, e il cancello che lo mangia ha un nome

I 22 ammissibili **che il board vede**, classificati col modello onesto a $61,25:

| rango | premio/g | cQ | tenuto? | mercato |
|---|---|---|---|---|
| 1 | **$5,942** | 156 | – | Democratic House members 24–27 |
| 2 | **$2,848** | 178 | – | Democratic House members (altra soglia) |
| 3 | $0,527 | 1.250 | – | Spider-Man: Brand New Day |
| 4 | $0,522 | 12.966 | – | Harry Kane Ballon d'Or |
| 5 | $0,494 | 1.109 | – | Bad Bunny top artist |
| **10** | $0,124 | 53.726 | **SÌ** | no Fed rate cuts 2026 |
| **13** | $0,075 | 10.124 | **SÌ** | LCK LoL Worlds |
| **14** | $0,074 | 24.823 | **SÌ** | 1 Fed rate cut 2026 |
| **16** | $0,037 | 37.994 | **SÌ** | Republican House |
| **17** | $0,030 | 47.371 | **SÌ** | Democratic House |

**Teniamo i ranghi 10, 13, 14, 16, 17 su 22 — la metà peggiore.**
Migliori 5 del board **$10,33/g** contro **$0,339/g** tenuti = **30,4×**.

### Il meccanismo, trovato e provato sul sorgente

`agents/agent41-realloc-scheduler.js:1357`
```js
if (id && fin(c.bestNetPerDay)) mappa[id] = c.bestNetPerDay;
```
`bestNetPerDay` viene annullato da `lib/rewards/net-per-day.js:80` quando **non ci sono fill
osservati** (`nessun-fill-osservato`). Un mercato **mai quotato** non ha fill, quindi non ha netto.
E `selezione-mercati.spodestaAbbastanza` (`:198-201`) rifiuta un netto `null`: *«un netto che non si
sa non spodesta e non si fa spodestare»*. Quindi:

> **un mercato che il bot non ha mai toccato non può MAI spodestare un occupante.**
> Può entrare solo in uno slot **libero**. Con 5/5 occupati, la selezione è **congelata**.

`nettiIniettati: 8` su **21** ammissibili ⇒ **13 mercati** strutturalmente esclusi dalla graduatoria.

**È un difetto già diagnosticato altrove nello stesso repo, e la cura esiste già accanto.**
`lib/rewards/allocator.js:986-996` espone `bestObiettivoPerDay` **proprio per questo**, e il commento
è esplicito: *«chi ordinava i candidati per `bestNetPerDay` non vedeva 33 dei 113 mercati valutati …
Sono i mercati SILENZIOSI, quelli su cui un maker vuole stare: il criterio li escludeva per la
ragione che li rende buoni.»* agent41 non lo usa.

Secondo cancello, che morde a valle: l'isteresi assoluta
`SPODESTA_MARGINE_USD_GIORNO = 0.50` (`selezione-mercati.js:184`). I netti reali di questi mercati
valgono **$0,022-0,03/giorno** (`realloc-ultimo-piano.json`: `netPerDay: 0.0224`). Il margine
assoluto è **~20× il netto di un occupante**: nessuno sfidante lo può superare a questa scala.

---

## 5 · LA STRATIFICAZIONE ONESTA DEL BOARD

Con `planBehindBest` — cioè col prezzo che il motore userebbe davvero — dei 108 mercati del board
**57** sono valutabili (gli altri: Q non misurabile, lato non quotabile, punteggio zero, size sotto
il minimo premiante).

| classe | n | premio/g mediano | resa mediana | q75 |
|---|---|---|---|---|
| **corti < 12 h** | 32 | **$4,216** | **6,88 %/g** | 21,23 %/g |
| corti 12-48 h | **0** | — | — | — |
| lunghi ≥ 48 h | 23 | $0,096 | 0,16 %/g | 0,30 %/g |
| lunghi ≥ 30 g | 21 | $0,075 | 0,12 %/g | 0,25 %/g |

**Il board è BIMODALE e in mezzo non c'è niente: zero mercati fra 12 e 48 ore.**

**Quanti hanno davvero un libro liquido, un montepremi sensato e una concorrenza battibile con
$1.495?** Sull'universo vero (1.556 ammissibili, **1.020 scorabili** col prezzo vero): **626** hanno spread ≤
banda (4,5¢) **e** cQ ≥ 100 — cioè libro vero e concorrenza reale. **848** hanno spread ≤ 10¢ e
cQ ≥ 20. Ma i mercati che **rendono** stanno nella coda opposta: dei **7** sopra $20/giorno, la
**mediana di cQ è 16,3** e lo spread mediano **4¢**. Sono libri **sottili ma veri** (4-43 livelli per
lato), non libri vuoti: la quota alta è il **premio per il rischio** di essere l'unico maker su un
binario che risolve fra 5 giorni.

**⚠ La mia prima stesura era sbagliata e va detto.** Avevo scritto che il modello grezzo è
«fantasia» perché pescava mercati a 6-10 ore con libri quasi vuoti. Metà di quella diagnosi era
giusta (mancava il pro-rata sulla vita residua), **metà era un mio errore di modello**: mettevo
l'ordine a 2,5¢ dal mid **sempre**, anche dove lo spread è 7¢ — cioè **davanti** al miglior bid
altrui, che «mai primo sul libro» vieta. Col prezzo vero di `planBehindBest` la distanza sale a
3-4,5¢, il punteggio crolla di 5-7× e i numeri cambiano. **Tutti i risultati di questo referto usano
il prezzo vero.**

---

## 6 · LA CURVA DEL CAPITALE, E L'ASINTOTO

Allocazione ottima (Lagrange su funzione concava con gradino al pavimento premiante), prezzo vero,
tetto di credibilità 0,60. `data/ricerca/curva-capitale.json`.

| scenario | $268 | $500 | $1.000 | **$1.495** | $6.000 | $30.000 | asintoto |
|---|---|---|---|---|---|---|---|
| universo VERO, nessun vincolo | $182,8 | $260,6 | $384,3 | **$481,1** | $1.001 | $2.161 | **$5.436** |
| universo VERO, cap $61,25, illimitati mercati | $182,0 | $257,7 | $378,3 | **$469,2** | $825,5 | $1.178 | $1.241 |
| universo VERO, cap $61,25 **+ 5 mercati** | $172,4 | $177,0 | $177,0 | **$177,0** | $177,0 | $177,0 | **$177,0** |
| **solo BOARD (22 visti), cap $61,25 + 5** | $10,0 | $10,3 | $10,3 | **$10,3** | $10,3 | $10,3 | **$10,3** |

**Il muro NON è di capitale.** In ogni scenario la curva è piatta **molto prima** di $1.495:
- con 5 mercati a $61,25 il capitale impiegabile è **$306,25** e il resto ($1.189) non ha dove andare;
- il board tagliato satura a **$10,33/giorno** a qualunque capitale.

**Capitale necessario per $5/giorno**, per bisezione: **$19** sull'universo vero (un solo mercato),
**$50** sul solo board. **Non serve più capitale: servono più mercati fra cui scegliere.**

---

## 7 · CORTI CONTRO LUNGHI — la coda lunga a 0,5 è la scelta sbagliata

| | resa mediana | rapporto |
|---|---|---|
| corti < 12 h, **valore pieno** | **6,88 %/giorno** | **44×** |
| corti < 12 h, **pro-ratati sulla vita residua** | **2,16 %/giorno** | **13,5×** |
| lunghi ≥ 48 h (quelli che teniamo) | **0,16 %/giorno** | 1× |

Anche scontando i corti per il fatto che muoiono in poche ore — cioè assumendo che **non** si riesca a
ruotare — rendono **13,5 volte** i lunghi per dollaro-giorno. Con rotazione, 44×.

**La conferma empirica sul nostro stesso conto, e vale più del modello.** Il 20/08 il bot ha quotato
**«Will Kai and Speed beat the gauntlet within 14 hours?»** — un mercato a **14 ore** — con
`inBandCapitalUsd: 33,12`, e ha incassato **$4,9455**. Il 19/08 teneva i Fed lunghi e ha incassato
**$0**. È **un'osservazione sola** e va trattata come tale, ma va nella stessa direzione del modello e
lo **supera**: il modello prevedeva ~$2,3 su $33 di capitale in un corto.

**Quindi: sì, i corti rendono molto di più, e la conclusione è che a essere sbagliato è il vincolo
«scadenza ≥ 24 h» della selezione (`selezione-mercati`), più ancora di `QUOTA_CODA_LUNGA`.** La coda
lunga a 0,5 governa la ripartizione *dentro* il piano; il cancello delle 24 h decide che i corti non
entrano affatto. **A togliere di più è il secondo.**

---

## 8 · IL COSTO DEL RISCHIO A QUELLA SCALA

### Quanto costa oggi essere riempiti — misurato

Equity dall'osservatore (`data/osservatore/campioni-*.jsonl`, `totalePortafoglioUsd`, 8.589 campioni):

| giorno | inizio | fine | delta | min intragiornata |
|---|---|---|---|---|
| 15/08 | $1.499,64 | $1.499,65 | +$0,01 | $1.499,64 |
| 16/08 | $1.499,65 | $1.493,08 | −$6,57 | $1.488,71 |
| 17/08 | $1.495,26 | $1.495,26 | −$0,00 | $1.495,26 |
| 18/08 | $1.495,26 | $1.492,43 | −$2,83 | $1.491,87 |
| 19/08 | $1.492,43 | $1.491,36 | −$1,07 | $1.491,36 |
| 20/08 | $1.491,36 | $1.487,93 | −$3,43 | **$1.461,40** |
| 21/08 | $1.492,87 | $1.494,78 | +$1,91 | **$1.459,80** |

**Equity 15/08 → 21/08: −$4,86 (−0,32%) in 6,6 giorni.** Nessun deposito né prelievo (verificato:
`DEPOSIT 0`, `WITHDRAWAL 0`). Rewards incassati nella finestra: **+$7,13**.
⇒ **costo di trading ≈ −$11,99 = −$1,82/giorno**, contro **+$1,08/giorno** di premio.
**Il bot perde circa $0,74 al giorno, netto.** Non è un disastro: è **sotto di poco**, e il segno è
negativo.

**⚠ CORREZIONE A UNA MIA CONCLUSIONE INTERMEDIA.** A metà lavoro avevo calcolato −$13/giorno di
perdita, partendo dal riferimento del guardiano ($1.550,18 del 16/08 19:28) come se fosse un livello
di equity reale. **L'osservatore lo esclude:** il 16/08 l'equity non ha mai superato **$1.501,63**.
Il riferimento include una valutazione di posizione di **$57,10** che nessun'altra fonte conferma.

### ⚠ Il guardiano è a $22 dallo scatto su un massimo che non è mai esistito

`riferimentoUsd = $1.550,17633`, fissato il 16/08 19:28 da una lettura `saldo $1.493,07 + posizioni
$57,10`. L'osservatore quel giorno vede al massimo **$1.501,63**. Il massimo mobile è quindi **~$50
troppo alto**, e la conseguenza è aritmetica:

- scatto a **$1.472,67** · equity **$1.494,78** · **margine $22,11 (1,43% del capitale)**;
- l'escursione intragiornata **misurata** è già stata di **$32,6** (20/08) e **$38,1** (21/08);
- il guardiano **è già scattato il 20/08 alle 22:36** (minimo $1.461,40, cioè −5,72%), e l'operatore
  ha dovuto riaccendere a mano il 21/08 alle 04:42.

**Risposta netta alla domanda: sì, a quella scala il guardiano scatterebbe regolarmente — e scatta
già adesso, a questa scala.** Con 20-30 mercati e fill sui libri sottili, l'escursione delle marche
crescerebbe con la radice del numero di posizioni: il margine di $22 verrebbe consumato ogni giorno.
**Una configurazione che si spegne ogni giorno non rende $5/giorno**, e il freno non è il cap di
esposizione ($650) né la perdita giornaliera ($100) — **è il drawdown mark-to-market a −5%.**

### Fill attesi

Dai campioni: **0-6 nuove posizioni al giorno**, massimo **4 contemporanee**. Tempo passato con una
gamba sola: 99,8% (15/08, il residuo murato di Hong Kong) → **1,5-17%** negli ultimi tre giorni.
A 20-30 mercati sottili con spread 5-7¢, il nostro ordine è **il più vicino al mid del libro**:
ogni taker che passa ci prende. **Non è misurabile da qui quanti fill produrrebbe** — servirebbe il
tape di quei mercati, che non abbiamo (v. §10).

Esposizione massima a coppie tutte riempite, con i vincoli di oggi:
`5 × $61,25 = $306,25` a riposo + `$306,25` di completamento = **$612,50**, sotto il cap di $650
(§5.2 p.37). A 20 mercati sarebbe **$2.450** — **oltre il cap di quasi 4×**, quindi il cap
morderebbe a metà rotazione, che è il guasto già visto il 16 agosto (§5-bis p.168).

---

## 9 · IL MONTEPREMI — la contrazione si è FERMATA

Serie storica (`data/ricerca/pagamenti-onchain.json`, 30 giorni al 13/08) contro la misura di oggi
(`screening-01-destinatari.js` sulla tx `0xbed2d3bc…`, giorno di competenza **20/08**, 7 batch):

| finestra | destinatari/giorno | pool/giorno |
|---|---|---|
| 14 g precedenti (15-28 luglio) | 2.679 | $117.306 |
| 14 g successivi (29 lug - 13 ago) | 2.523 (−5,8%) | $90.830 (−22,6%) |
| minimo toccato (08/08) | 2.596 | **$80.185** |
| **oggi (20/08, misurato)** | **2.493** | **$105.336** |

**Il pool è risalito del +31,4% dal minimo dell'8 agosto e sta sopra la media delle due settimane
precedenti (+16,0%).** I destinatari sono stabili (−1,2% sulla media recente).
**La contrazione che il prompt dà per in corso non è più in corso**, e l'obiettivo non va rivisto al
ribasso per quel motivo.

### Il bracket dei 54 wallet, rimisurato oggi

Stesso filtro del censimento (5-24 mercati, capitale $800-3.000), 54 wallet, 14 giorni di pagamenti
REWARD veri (`data/ricerca/bracket-oggi.json`):

| | 15 agosto | **oggi** |
|---|---|---|
| wallet a **zero** in 14 giorni | 33/54 | **33/54 (61,1%)** |
| mediana $/giorno | $0,00 | **$0,00** |
| q75 $/giorno | $0,81 | **$0,58** |
| massimo $/giorno | $202,03 | **$178,57** |
| **wallet ≥ $5/giorno** | — | **10/54 (19%)** |

**I 33 a zero sono esattamente i 33 del prompt: quel numero non è migliorato.**
E il wallet di riferimento **`0xf0578c22` è crollato del −65,5%**: da $2.828,44/14 g ($202,03/giorno)
a **$975,76/14 g ($69,70/giorno)**. **Il risultato che il prompt chiede di riprodurre non è più
riprodotto nemmeno da chi lo aveva ottenuto.**

**Questa è la calibrazione che tiene a terra il modello.** Il modello dice $469/giorno su $1.495.
Il miglior wallet reale della nostra fascia fa **$178,57/giorno**, e la mediana fa **zero**. Il
modello va letto come **limite superiore**, non come previsione: **$5/giorno è il risultato del
quintile alto (19%), non il caso base.**

---

## 10 · Cosa NON sono riuscito a misurare

1. **Quanti fill produrrebbe una configurazione a 20-30 mercati sottili.** Servirebbe il tape di
   quei mercati; `data/mid-history` copre solo i mercati sottoscritti da agent34, e la corsia
   `collector-priority` è seminata dal piano — che è fermo al 19/08 per l'OOM di §3.
2. **La stratificazione dei 54 wallet del bracket per configurazione.** Il censimento porta
   `mercatiInsiemeOra` e `distanzaMidMedianaCents` solo per gli **8** wallet di `gruppoIncassa`:
   dei 10 che oggi fanno ≥ $5/giorno ho i metadati di **uno solo**. Non posso quindi dire *quale
   configurazione* distingue chi incassa da chi sta a zero — solo che la differenza esiste.
3. **Se le quote alte sui libri sottili siano incassabili davvero.** Ho **una** osservazione a
   favore (Kai & Speed, $4,95 su $33 di capitale) e nessuna contraria. `n = 1`: non conclude.
4. **Il costo di adverse selection per fill.** L'equity aggrega premi, marche e fill; nessun file
   attribuisce il P&L al singolo fill, e il venue paga un bonifico **aggregato** (§4.12).
5. **Il tick dei 1.534 mercati non visti** è **dedotto** dai decimali del libro, non letto da
   `/tick-size` (non esiste un batch). Un tick sbagliato sposta il prezzo di `planBehindBest` di un
   livello.

---

## 11 · LE TRE STRADE — ordinate per rendimento/rischio, non per rendimento

### ① ALLARGARE LA VISTA — il miglior rapporto, e il rischio non cambia
| | |
|---|---|
| **cosa cambia** | `REWARD_MAX_CLOB_MARKETS` (`agent24:71-72`) e/o la fase di profondità passa a `POST /books` in lotti |
| **premio atteso** | modello **$177/g** a 5 mercati / $306 di capitale · **calibrato sul bracket reale: $5-25/giorno** |
| **esposizione massima** | **invariata**: $612,50, sotto il cap di $650 |
| **rischio di fill** | **invariato** — stessi 5 slot, stesso tetto, stessa distanza. Cambia *da quale insieme* si sceglie |
| **da riparare PRIMA** | ① `agent41:1357` deve usare `bestObiettivoPerDay` e non `bestNetPerDay`, o i mercati nuovi non spodesteranno mai e allargare la vista non produrrà nulla; ② l'isteresi assoluta di $0,50/g va rapportata alla scala vera dei netti; ③ l'OOM del piano, o il ciclo pesante resta cieco |

**È l'unica strada che alza il rendimento senza toccare un solo limite di rischio.**

### ② APRIRE AI CORTI — rendimento più alto, rischio più alto, ma quantificato
| | |
|---|---|
| **cosa cambia** | il cancello «scadenza ≥ 24 h» della selezione scende (12 h è il confine misurato di §4.4: fra 6-12 h le uscite oltre la risoluzione sono 0/36) |
| **premio atteso** | resa mediana **2,16 %/g pro-ratata** contro 0,16% dei lunghi ⇒ su $306 di capitale, **$6,6/giorno** modellati |
| **esposizione massima** | invariata ($612,50), ma **ruota molto più in fretta** |
| **rischio di fill** | **il più alto delle tre**: un binario che risolve fra ore è adverse selection pura, ed è la ragione per cui quei libri sono sottili |
| **da riparare PRIMA** | ① la **chiusura forzata a 3 ore** dalla risoluzione deve essere provata viva su mercati corti; ② `ripristinaGamba` è inerte finché il piano è in OOM; ③ il riferimento del guardiano va rifatto — con rotazione veloce le marche oscillano di più, e oggi il margine è $22 |

### ③ CONCENTRARE — la peggiore delle tre, e va detto
| | |
|---|---|
| **cosa cambia** | alzare il tetto per mercato oltre $61,25 |
| **premio atteso** | sul solo board **+$23,26/g** modellati (da $10,33 a $33,59) — sembra molto |
| **esposizione massima** | **cresce linearmente col tetto**, e il cap di $650 morde **a metà gestione** |
| **rischio di fill** | concentra su meno mercati: **peggiora** la diversificazione proprio mentre il guardiano ha $22 di margine |
| **da riparare PRIMA** | è la strada che il repo ha già percorso e da cui è tornato indietro (§5-bis p.168: un tetto che impedisce di CHIUDERE non è un limite di rischio, è un rischio) |

**Ordine finale: ① ≫ ② > ③.**

---

## 12 · LA RISPOSTA NETTA

**$5/giorno di premio lordo è raggiungibile con questo capitale — ma non con questo board, e non è
il caso base: è il risultato del 19% migliore della nostra fascia.**

Le tre cose che lo dicono, e sono misurate:
1. **è già successo tre volte** ($8,35 · $6,98 · $4,95) e uno di quei giorni è stato prodotto da **un
   solo mercato corto con $33 di capitale**;
2. **10 wallet su 54** della nostra identica fascia lo superano oggi — e **33 su 54 stanno a zero**;
3. **non serve capitale**: la curva è piatta oltre **$306** con i vincoli di oggi, e il capitale
   necessario per $5/giorno è **$19-50**, non $1.495.

**Il "ma" che conta, e per cui la risposta onesta non è un sì pieno:** il premio lordo non è il
risultato. Negli ultimi 6,6 giorni il bot ha incassato **$7,13** di premi e ha perso **$11,99** di
trading: **−$0,74/giorno netto**. Portare il premio a $5/giorno senza toccare il costo dei fill
significa moltiplicare **entrambi**. E il freno che si incontra per primo non è nessuno dei limiti
che il prompt elenca — **è il guardiano a −5%, che ha $22,11 di margine, che oscilla già di $38 al
giorno, e che è scattato ieri.**

**Quindi: sì al punto ①, che alza il premio senza toccare il rischio, dopo aver riparato
`agent41:1357`. No a qualunque configurazione che arrivi a $5/giorno alzando i tetti o la size
prima che il riferimento del guardiano sia rifatto**: quella configurazione si spegnerebbe ogni
giorno, e un bot spento non rende $5/giorno.

---

## 13 · DIFETTI TROVATI — dichiarati, NON corretti

⚠ Non sono stati scritti in `CLAUDE.md` §5.2 come vorrebbe la disciplina della diagnosi: il perimetro
di questa sessione è «scrivi solo in `data/ricerca/`». Vanno riportati là da chi decide.

**D-A · `agent41:1357` ordina i candidati con un campo che è `null` per i mercati mai quotati.**
`if (id && fin(c.bestNetPerDay)) mappa[id] = c.bestNetPerDay;` — `bestNetPerDay` è annullato da
`net-per-day.js:80` quando non ci sono fill osservati. Un mercato mai toccato non ha netto, e
`spodestaAbbastanza` (`selezione-mercati.js:198`) rifiuta un netto `null` ⇒ **non può mai
spodestare**. Con 5/5 slot occupati la selezione è congelata. `nettiIniettati: 8` su 21 ammissibili.
La cura esiste già accanto: `allocator.js:995` espone `bestObiettivoPerDay` **per questo motivo
esatto**, documentato con la misura dell'8 agosto (33 mercati su 113 invisibili alla graduatoria).

**D-B · l'isteresi assoluta dello spodestamento non è nella scala dei netti veri.**
`SPODESTA_MARGINE_USD_GIORNO = 0.50` (`selezione-mercati.js:184`) contro netti reali di
**$0,022-0,03/giorno** (`realloc-ultimo-piano.json`). Il margine assoluto vale **~20×** il netto di
un occupante: a questa scala il ramo relativo (25%) non entra mai in gioco e nessuno sfidante può
superare l'asticella. Non è un difetto di logica — è un numero tarato su una scala che non è questa.

**D-C · il figlio del pianificatore va in OOM a ogni ciclo pesante, e nessuno reagisce.**
924 MB di heap su 604 MB disponibili; 4 cicli su 4 al giorno dal 19/08 15:25 (47 h). Il fallimento è
**scritto** (giornale + log pm2) ma **nessuna difesa agisce**: il ciclo prosegue con
`lastAzione:"nessuna"`. Conseguenze: trigger di valore mai misurabile, `ripristinaGamba` senza riga
di piano, piano salvato vecchio di due giorni. Il secondo modo di morte è `timeout 120000ms`.

**D-D · il riferimento del guardiano è stato fissato da una marca che nessun'altra fonte conferma.**
`guardian-baseline.json` = **$1.550,17633** al 16/08 19:28, da `saldo $1.493,07 + posizioni $57,10`.
L'osservatore, che campiona ogni 60 s, quel giorno non vede mai più di **$1.501,63**. Il massimo
mobile è ~$50 troppo alto e il drawdown corrente (−3,573%) è in buona parte un artefatto: **è la
ragione per cui il margine è $22,11 e per cui il guardiano è scattato il 20/08 alle 22:36.**

**D-E · `scripts/cli/stato.js` dichiara che le cinture divergono fra i processi.**
Riga: «⚠ LE CINTURE DIVERGONO fra i processi che decidono un prezzo». La divergenza dichiarata è fra
i **processi** e il **`.env`**, non fra agent40 e agent41 (che risultano identici, 4/4 aperte). È lo
stesso difetto già annotato in `CLAUDE.md` («`stato.js` stampa una riga … che è sbagliata e
rassicura»), qui nella forma opposta: **allarma** su una divergenza che non c'è fra i due processi.

**D-F · il tetto di 150 mercati è motivato da un costo che dipende dal metodo, non dal venue.**
`agent24:73-91` deriva 150 da «2,7 s per mercato» misurati su `/book?token_id=` **uno alla volta**.
`POST /books` esiste ed è pubblico (verificato: 3.112 libri in ~40 s con lotti da 40). Non è un
difetto di correttezza — è un commento che descrive un vincolo come se fosse del venue.

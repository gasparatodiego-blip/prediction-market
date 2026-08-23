# Referto — «Fai lavorare tutto il capitale»
**23 agosto 2026, 08:53Z.** Sola lettura per le misure, poi applicazione nello stesso giro.
Commit `44e0a45`. Processi riavviati: **agent40** (pid 869708) e **agent41** (pid 869709).

---

## 1 · IL CENSIMENTO — due numeri secchi

| | |
|---|---|
| mercati premiati che il venue espone | **1.275** ⚠ a sua volta **parziale** |
| mercati che agent24 guarda davvero | **300** |
| mercati che finiscono a board | **252** |

**⇒ 975 mercati (76,5% del censito) non vengono MAI guardati.**

Pagine lette e budget, dal log di agent24: `21p listino (+626) · 120p in 7/8 fette da 6h (+317
nuovi entro 2g) · **5 fette al tetto dei 2.100: copertura PARZIALE** · **budget fette esaurito a
120p** oltre +42h → 1275 mercati premiati`. Quindi anche il 1.275 è un **limite inferiore**: il
budget `REWARD_FAST_MAX_PAGES = 120` (`agent24:149`) si esaurisce prima di finire, e 5 fette su 8
tornano troncate dal tetto di 2.100 record di Gamma.

Il taglio da 1.275 a 300 è `REWARD_MAX_CLOB_MARKETS` — **`agents/agent24-liquidity-rewards.js:71`**.
⚠ Il cronometro dello stesso ciclo dice che **382 starebbero nel periodo** («profondità: 7,1 min per
300 mercati = 1,41 s/mercato · a questo ritmo il tetto che sta nel periodo è ~382»): il 300 è
prudente rispetto alla misura di adesso, non al limite.

## 2 · LA PIRAMIDE COMPLETA, dal totale censito

| cancello | file:riga | toglie | restano |
|---|---|---:|---:|
| censiti dal venue | log agent24 | — | **1275** |
| **tetto di scansione** | `agent24-liquidity-rewards.js:71` | **−975** | 300 |
| **pavimento di profondità** (`depthFloorUsd` 25) | agent24 · `suppressedThinDepthMarkets` | **−48** | 252 |
| riga-assente / senza-conditionId | `selezione-mercati.js:388,391` | −0 | 252 |
| minsize-illeggibile | `selezione-mercati.js:396` | −0 | 252 |
| **minsize-oltre-soglia** (>50 ⇒ pavimento >$61,25) | `selezione-mercati.js:399` | **−33** | 219 |
| scadenza-non-determinabile | `selezione-mercati.js:405` | −1 | 218 |
| scadenza-discorde | `selezione-mercati.js:411` | −0 | 218 |
| scadenza-troppo-vicina (<24 h) | `selezione-mercati.js:417` | −9 | 209 |
| scadenza-oltre-orizzonte-piano | `selezione-mercati.js:426` | −4 | 205 |
| **famiglia-meteo** | `selezione-mercati.js:433` | **−172** | 33 |
| quarantena venue + slot-sterile ⚠ **silenzioso** | `agent41-realloc-scheduler.js:2479` | −2 | 31 |
| già selezionati (occupano uno slot) | `selezione-mercati.js:1288` | −8 | **23** |

**⇒ 23 ammissibili e liberi: 22 LUNGHI (≥48 h) e 1 CORTO.**
⚠ Il cancello della quarantena è **silenzioso**: non compare in `scartatiPerComposizione` né in
`scartatiPerFascia` (§5.2 p.62, dichiarato non corretto).

**I tre che tolgono di più**: tetto di scansione **−975** (`agent24:71`) · famiglia-meteo **−172**
(`selezione-mercati.js:433`) · minsize-oltre-soglia **−33** (`selezione-mercati.js:399`).

## 3 · IL MINSIZE — e perché abbassare la size non aiuta

`rewardsMinSize` sul board: **20 → 195 mercati · 50 → 24 · 100 → 17 · 200 → 16**.
Pavimento premiante = `minSize × 0,98 × 1,25` ⇒ `20 ⇒ $24,50 · 50 ⇒ $61,25 · 100 ⇒ $122,50 · 200 ⇒ $245`.

**33 mercati cadono** perché il pavimento supera $61,25 (cioè `minSize > 50`).

**⚠ A $30 per lato NON tornano finanziabili: se ne PERDONO 24.** A $30 il pavimento finanziabile è
`minSize ≤ 24`, quindi restano i **195** a minSize 20 e cadono i **24** a minSize 50 (pavimento
$61,25 > $30) — che oggi sono finanziati. Abbassare la size **non aggiunge un solo mercato** e ne
toglie 24: la premessa del punto 7 non regge, e il punto 7 **non è stato applicato**.

## 4 · LE VIE DI RIPIEGO — le share si contano per MERCATO, e il premio NON si ferma

Regola del venue, dal disclaimer del board e da `lib/rewardScore.js`: il punteggio è
`S(v,s) = ((v−s)/v)²` con combinazione a due lati, e `Q_utente = Σ S(v,sᵢ)·sizeᵢ` sommata su
**tutti i propri ordini a riposo nel book di QUEL mercato**. La quota è
`Q_utente / (Q_utente + Q_concorrenti)`. **Si conta per MERCATO, non per ordine.**

**⚠ Il $61,25 è NOSTRO, non del venue.** `lib/rewards/concentration.js` lo definisce come tetto di
concentrazione: il venue ha solo un **pavimento** (`min_incentive_size`), nessun soffitto. Cercato
`max_incentive` / cap per mercato nel codice del venue: **zero occorrenze**.

**Misurato sui 30 mercati lunghi ammissibili, a 3,0¢ dal mid, con la concorrenza di adesso:**

| capitale per mercato | quota mediana | premio mediano | premio TOTALE | marginale |
|---|---|---|---|---|
| **$61,25** (tetto attuale) | 0,697% | $0,2932/g | **$41,83/g** | — |
| $122,50 | 1,385% | $0,5793/g | **$78,12/g** | +$59,25 ogni $100 |
| $245,00 | 2,731% | $1,1313/g | **$138,85/g** | +$49,58 ogni $100 |
| $490,00 | 5,314% | $2,1612/g | **$230,49/g** | +$37,40 ogni $100 |

**⇒ Raddoppiare sullo stesso mercato NON matura zero: quasi raddoppia il premio.** La quota satura
solo quando `Q_nostro` si avvicina a `Q_concorrenti`, e a $61,25 siamo allo **0,7%**: siamo lontani
dalla saturazione, la resa è quasi lineare. **Non applicato** perché il punto 7 vieta di superare
$61,25 per mercato — va al punto 8.

## 5 · LE DISTANZE — valori letti da `/proc` PRIMA, e il conto del margine

**Prima** (`/proc/865747` e `/proc/865753`): `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V=0.7777777777777778`
(**3,500¢**) · `MAKER_DISTANZA_CORTI_CENTS=3.0` · `MAKER_SLOT_CORTI=5` · `MAKER_MERCATI_CONTEMPORANEI=12`.

**Dopo** (`/proc/869708` e `/proc/869709`): `…FRAZIONE_V=0.6666666666666666` (**3,000¢**) ·
`MAKER_DISTANZA_CORTI_CENTS=3.5` · `MAKER_SLOT_CORTI=2` · `MAKER_MERCATI_CONTEMPORANEI=12`.

| fascia | banda · tick | mercati | distanza | margine dal bordo | tick |
|---|---|---:|---|---|---|
| LUNGHI | ±4,5¢ · 1,0¢ | 16 | 3,000¢ | 1,500¢ | **1,50** ✔ |
| LUNGHI | ±4,5¢ · 0,1¢ | 10 | 3,000¢ | 1,500¢ | 15,00 ✔ |
| LUNGHI | ±5,5¢ · 0,1¢ | 4 | 3,667¢ | 1,833¢ | 18,33 ✔ |
| CORTI | ±4,5¢ · 1,0¢ | 1 | 3,500¢ | 1,000¢ | **1,00** ✔ |
| CORTI | ±5,5¢ · 1,0¢ | 2 | 3,500¢ | 2,000¢ | 2,00 ✔ |

**33 mercati su 33 tengono almeno un tick. Zero sotto.**

**⚠ Dove non è esprimibile si arrotonda verso l'interno, ed è misurato, non promesso**: su griglia da
1¢ **3,5¢ non è un prezzo**. Dopo il riavvio delle 08:21Z il giornale mostra `richiesta 3,5¢ →
distanzaMid **3,45¢**`, cioè **più vicino al mid** del bersaglio, mai più vicino al bordo. E il
paletto di `applicaObiettivo` garantisce il tetto comunque: chiedendo 4,0¢ si ottiene 3,5¢
(`alBordo: true`). **3,0¢ per i lunghi è invece esprimibile esattamente.**

Un solo punto per fascia: `const DISTANZA_LUNGHI_FRAZIONE_V` (`ecosystem.config.js:148`, referenziato
dai due blocchi `env`) e `MAKER_DISTANZA_CORTI_CENTS` (una sola riga).

## 6 · GLI SLOT — il 7 era configurazione, non scarsità

Il 7 dei lunghi **non era scritto da nessuna parte**: è `lunghi = totale − corti`
(`lib/maker/quanti-mercati.js`), e l'unico numero scritto era `MAKER_SLOT_CORTI: '5'`
(`ecosystem.config.js:603`). Con 5 posti corti, **3 restavano vuoti per scarsità vera** (un solo
corto ammissibile su 23) mentre la fascia lunga era **PIENA a 7/7 con 22 lunghi in attesa fuori**.

**`MAKER_SLOT_CORTI` 5 → 2 ⇒ 2 corti + 10 lunghi derivati = 12.** `MAKER_MERCATI_CONTEMPORANEI`
**non toccato** (12).

**⚠ Restano fuori 19 lunghi ammissibili su 22**, e per due ragioni distinte: 3 sono entrati, e dei
19 rimasti **14 sono nel secchio «basso»** (`rewardsMinSize ≤ 20`) contro una quota `basso: 1` già
occupata — `quota-scaglione-piena`. Il collo, dopo questo giro, **non è più la fascia: è la
composizione per scaglione** (§5.2 p.57, cura scritta ma non applicata per istruzione).

## 7 · LA SIZE — non abbassata, e il conto del perché

**L'invariante regge e non è stata toccata:**
`12 slot × 2 gambe × $61,25 = **$1.470,00** ≤ cap **$1.470**` — uguaglianza esatta.
`esposizioneMassimaRaggiungibileUsd(12) = $1.470`. **N = 13 sfonderebbe** ($1.592,50).

Il capitale al lavoro raggiungibile a 12 slot col tetto attuale è
`12 × $61,25 = $735` di nozionale a riposo ⇒ **$761,31 = 51,1%** — sotto l'80% chiesto.
Ma **abbassare la size non ci arriva**, e il conto lo dice:
- il numero di slot è tappato a **12** da `MAX_MERCATI_CONTEMPORANEI` (`selezione-mercati.js:176`) e
  dal cap: size più piccola **non crea slot**;
- a $30 per lato si **perdono 24 mercati** (§3), quindi la platea si restringe;
- il capitale al lavoro è `slot × tetto per mercato`, e abbassare il secondo **abbassa il prodotto**.

**Size lasciata a $61,25 per mercato. Il punto 7 non è applicabile come scritto.**

## 8 · COSA MANCA PER IL 100% — proposte, NON applicate

Al lavoro raggiungibile oggi: **51,1%**. Mancano ~**$730** per arrivare al 100%.
Le tre leve, con il rischio in dollari misurato:

| leva | dove | guadagno | rischio in dollari |
|---|---|---|---|
| **① alzare il tetto per mercato** $61,25 → $122,50 | `concentration.js` | premio da **$41,83 a $78,12/g** (misurato §4) | esposizione massima raggiungibile `12×2×122,50 = **$2.940**` contro cap $1.470 ⇒ **sfonda di $1.470**. Servirebbe scendere a **6 slot** (6×2×122,50 = $1.470) — meno diversificazione, stesso capitale |
| **② alzare il cap** $1.470 → $2.940 con 12 slot a $122,50 | `data/safety-risk-limits.json` | idem | il cap è un **budget, non un permesso** (§4.2): `capitale = min(saldo, maxOpenNotionalUsd)` ⇒ è un **ordine di allocare di più**. A $2.940 su equity $1.491 il limite diventa **inerte**, e la difesa residua è il solo kill a **−$100** |
| **③ alzare il tetto di scansione** 300 → 382 | `agent24:71` | +82 mercati visti, ~**+7 ammissibili** stimati pro-rata | zero rischio di capitale; costo = tempo di scansione, e il cronometro dice che 382 sta nel periodo di 15 min. **È la leva a rischio più basso**, e non tocca nessun limite |

⚠ **La leva ③ da sola non basta**: aggiunge candidati, ma il collo è la quota `basso: 1` e il tetto
di 12 slot. **Nessuna delle tre è stata applicata.**

## 9-13 · L'APPLICAZIONE, e lo stato dopo

**Prima del riavvio**: 16 ordini a riposo su 8 mercati, $416,08 · 7 coppie · 1 gamba scoperta a
libro · 2 posizioni aperte (`0x4d79d306` 56,1 @0,4145 carico 0,494 · `0xd947c421` 56,1 @0,0545
carico 0,065) — **non vendute**. Riavviati **solo** agent40 e agent41, che sono i due che leggono
la manopola e si riavviano **insieme** (§5.1). Il riavvio ha **azzerato la quarantena slot-sterile in
memoria**: ne sono usciti `0x684e5b72` (NVIDIA), `0xf3c634bd` (Musk <40 tweet), `0x790474c0` (Trump
180-199 Truth) — e infatti Trump è già rientrato a libro con una coppia da $52,68.

**Dopo un ciclo (08:50:36Z):**

| | |
|---|---|
| slot occupati | **12 su 12** — **10 lunghi** (su 10) + **2 corti** (su 2) |
| posti vuoti | **nessuno** (`postiVuoti: []`, `postiNonAssegnati: []`) |
| entranti | 3, tutti di fascia lunga |
| ordini a riposo | **18 su 9 mercati** (i 3 nuovi si stanno riempiendo) |
| nozionale a riposo | **$470,61** |
| size per lato | ~$26 · **per mercato ~$52,5**, sotto il tetto di $61,25 |
| capitale al lavoro | **$496,92 / $1.490,78 = 33,3%** · a regime su 12 mercati ≈ **44%**, tetto teorico **51,1%** |

**La suite**: `251 test · 241 verdi · **9 ROSSI** · 1 non parte`. Gli 8 noti più
`allowlist-con-posizioni`, che ho verificato essere **15/2 identico anche su HEAD**: preesistente e
dipendente dallo stato vivo, non introdotto da questo giro. `tre-fix-sicurezza` è uscito dai rossi
(è il timeout di §5.2 p.42), `selezione-cablata` resta dentro (§5.2 p.61, rosso al primo fill).

## Difetti trovati e NON corretti

1. **`CLAUDE.md` dice il falso sul riavvio di agent40**: afferma «OGNI RIAVVIO DI agent40 ABBANDONA
   GLI ORDINI GIÀ A LIBRO». Misurato: `preesistenti-adottati` con **14 ordini adottati su 15**, 1
   solo invisibile (`1-origine-non-auto`). Classe D7, su una decisione di deploy.
2. **La quarantena non compare in nessuna lista di scarto** (§5.2 p.62): entra in `escludi` e cade
   prima del cancello di composizione, quindi `slotVuotiPerScarsita` attribuisce il vuoto alla
   ragione sbagliata.
3. **Il censimento è parziale due volte**, e solo una è dichiarata: il tetto di 300 è nel log, ma il
   `budget fette esaurito` significa che anche il **1.275 è un limite inferiore** — il numero di
   mercati premiati che il venue espone davvero **non è noto**.

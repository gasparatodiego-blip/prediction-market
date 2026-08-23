# Referto — «Ripara il piano e porta il capitale al lavoro sopra l'80%»
**23 agosto 2026, 10:05Z.** Solo misure. **NIENTE È STATO APPLICATO**, per la regola del punto 4.

> ## ⛔ FERMATO AL PUNTO 4, E PER DUE RAGIONI INDIPENDENTI
> **① La causa accertata è sbagliata.** Non è la corsia websocket (§5.2 p.55): **tutti e 12 i
> mercati selezionati hanno `profondita: 'misurata'`**. La corsia li copre tutti. Il piano li scarta
> per due ragioni **economiche e già dichiarate**: `quota-coda-lunga` (5) e `netto-negativo` (5).
> **② Uno dei quattro mercati fermi resta fermo anche con la correzione**, perché ha un netto atteso
> di **−$2,17/giorno**. Il punto 4 dice: «se anche solo uno resta fermo, hai riparato il sintomo
> sbagliato: dillo e fermati senza applicare il resto». Fermato.
>
> **Nessun file di produzione è stato modificato. Nessun processo riavviato. Nessun ordine toccato.**

---

## 1 · LA CAUSA ESATTA — misurata, e non è quella accertata

**Chi compone il piano**: `lib/rewards/allocator.js` → `planFromCollection`, eseguito in un processo
figlio (`RUNNER_PIANO`, `agents/agent41-realloc-scheduler.js:613`) e ristretto ai selezionati da
`restringiAllaSelezione` (`agent41-realloc-scheduler.js:640`, che usa `idsAttivi`).

Eseguito **adesso** sui 12 selezionati attivi, capitale $1.464,47, tetto $61,25:

| mercato | netto $/g | profondità | `reasonCode` | status |
|---|---:|---|---|---|
| `0x790474c0` Trump 180-199 | **+3,4051** | misurata | — | **scelto** |
| `0xaa74d4f5` Don't Say Good Luck | **+1,9851** | misurata | — | **scelto** |
| `0x684e5b72` NVIDIA | +0,4538 | misurata | `quota-coda-lunga` | scartato |
| `0x76c1a69f` Spider-Man | +0,1845 | misurata | `quota-coda-lunga` | scartato |
| `0x14d32732` Avengers | +0,0779 | misurata | `quota-coda-lunga` | scartato |
| `0x5e082f0b` Fed 1 taglio | +0,0222 | misurata | `quota-coda-lunga` | scartato |
| `0x4e4f77e7` Republican House | +0,0050 | misurata | `quota-coda-lunga` | scartato |
| `0xd4e77ba6` no Fed cuts | **−0,0356** | misurata | `netto-negativo` | scartato |
| `0x12dc2b61` Harry Kane | **−0,0376** | misurata | `netto-negativo` | scartato |
| `0x80b3af88` Fed rialzo | **−0,1746** | misurata | `netto-negativo` | scartato |
| `0xf3c634bd` Musk <40 tweet | **−2,1651** | misurata | `netto-negativo` | scartato |
| `0x316e494b` Musk 40-64 tweet | **−7,9862** | misurata | `netto-negativo` | scartato |

**⇒ 2 righe su 12, non 4. E la corsia websocket non c'entra:**
`profondita` sui 12 selezionati = `{"misurata": 12}`. **Zero `non-verificata`.**
(Sui 307 candidati totali, 295 hanno profondità `?` — ma quelli non sono selezionati e non sono il caso in esame.)

**Le due cause vere, con file e riga:**
1. **`quota-coda-lunga`** — `lib/rewards/allocator.js`, il cancello della quota di coda lunga (§4.4:
   «il capitale oltre `LONG_TAIL_DAYS 7` non supera il **12%** del piano»). **8 dei 12 selezionati
   sono di coda lunga** (68,6 · 129,6 · 129,6 · 129,6 · 129,6 · 71,6 · 107,6 · 129,6 giorni): la
   fascia corta ha solo 4 mercati e la quota che la coda riceve è calcolata su quella.
2. **`netto-negativo`** — il netto atteso è sotto zero: quei mercati **costano** capitale.

**⚠ E il piano salvato su disco era di CINQUE ORE prima** (`realloc-ultimo-piano.json`,
`at: 2026-08-23T04:42:49Z`), mentre il giornale dichiara una ricostruzione a ogni mini-ciclo: la
ricostruzione **non viene persistita**. Difetto dichiarato, non corretto.

## 2-3 · LA CORREZIONE E L'ALLARME — **non applicati**

La correzione chiesta (ogni selezionato ha una riga, con motivo dichiarato) è **giusta come
osservabilità** e la userei: renderebbe visibile ciò che ho dovuto ricostruire eseguendo
l'allocatore a mano. Ma **non riparerebbe il capitale fermo**, perché le righe mancanti non sono
sparizioni silenziose: sono **scarti dichiarati con un `reasonCode`**, già presenti in
`piano.candidates`. Il degrado non è silenzioso nel piano — è silenzioso **nel giornale**, che
riporta solo `righe: 4` senza i motivi.

## 4 · SIMULAZIONE A SECCO SUI QUATTRO FERMI — **uno resta fermo, quindi mi fermo**

| mercato | fermo da | motivo vero | con la correzione riceve una riga? | riceve un ORDINE? |
|---|---|---|---|---|
| `0x684e5b72` NVIDIA | 236 min | `quota-coda-lunga`, netto **+0,45**/g | sì | **solo se la quota di coda lunga sale** |
| `0x5e082f0b` Fed 1 taglio | ~15 min | `quota-coda-lunga`, netto **+0,02**/g | sì | idem |
| `0x4e4f77e7` Republican House | ~15 min | `quota-coda-lunga`, netto **+0,005**/g | sì | idem |
| `0xf3c634bd` Musk <40 | 208 min | **`netto-negativo`, −$2,17/g** | sì | **NO, e non deve** |

**`0xf3c634bd` resta fermo per costruzione.** Una riga di piano che dichiara `netto-negativo` non
produce un ordine, e non deve: allocare $61,25 su un mercato con netto atteso **−$2,17/giorno**
significa pagare per stare a libro. Forzare l'ordine sarebbe scavalcare il modello economico, non
riparare un difetto.

**⇒ Il punto 4 scatta: «hai riparato il sintomo sbagliato». Fermato senza applicare il resto.**

⚠ E gli altri tre non sono un affare: netto **+$0,45 · +$0,02 · +$0,005 al giorno**. Anche
riempiendoli tutti e tre, il piano guadagnerebbe **$0,48/giorno** contro i $5,65/giorno che le due
righe scelte già producono. **Il capitale fermo non è capitale sprecato: è capitale che il modello
si rifiuta di mettere su mercati che non rendono.**

## 5-6-8 · I CONTI CHIESTI — calcolati, **non applicati**

**Il cap a $2.400** (`N × 2 × $61,25 ≤ cap`):

| cap | N max | nozionale a riposo | capitale al lavoro | cassa residua |
|---|---:|---|---|---|
| $1.470 (attuale) | **12** | $735,00 | $759,63 = **51,0%** | $729,47 ✔ |
| $2.400 | **19** | $1.163,75 | $1.188,38 = **79,8%** | **$300,72** ✔ sopra $250 |

**⚠ $2.400 arriva al 79,8%, non all'80%.** Mancano **0,2 punti**. Per superare l'80% servirebbe
`cap ≥ $2.412`. Non applicato comunque.

**Mercati ammissibili**: ne esistono **33** (15 basso + 18 alto), di cui **21 liberi**. Per N=19 ne
servono 19: **bastano**. La quota a N=19 sarebbe `round(19/3) = **6 basso + 13 alto**`, e i 14
candidati «basso» liberi avrebbero 6 posti — ne entrerebbero **6**, non 14.

**Il guardiano, con il cap raddoppiato** (misura, non ritarata):

| | cap $1.470 · N=12 | cap $2.400 · N=19 |
|---|---|---|
| esposizione massima raggiungibile | $1.470,00 | **$2.327,50** |
| perdita max in un ciclo (coppia a 101¢ contro merge a 100¢) | $7,36 | **$11,66** |
| soglia guardiano (5% di $1.489,10) | $74,45 | $74,45 |
| kill giornaliero R10 | −$100 = 6,72% dell'equity | idem |

**⇒ Restano coerenti.** La perdita massima di un ciclo ($11,66) è **un sesto** della soglia del
guardiano e **un nono** del kill: raddoppiare il cap non avvicina nessuna delle due difese al loro
punto di scatto. ⚠ Ma il cap **è un budget, non un permesso** (§4.2): a $2.400 su equity $1.489 il
limite diventa **quasi inerte**, e la difesa effettiva si riduce al guardiano e al kill. **Non
ritarati, come richiesto.**

## 9 · ORDINI VIVI — stato al momento della misura

16 ordini a riposo su 8 mercati, **$423,89** · 6 coppie · **2 gambe scoperte a libro** · **2
posizioni aperte** (`0x4d79d306` 56,1 @0,386 carico 0,494 · `0xd947c421` 56,1 @0,053 carico 0,065),
**non vendute**. **Nessun processo riavviato, zero ordini toccati, la quarantena in memoria di
agent41 è intatta.**

## Difetti trovati e NON corretti

1. **Il piano valuta a 1¢ dal mid mentre il bot quota a 3,0¢.** `piano.offsetCents = 1`: tutti i
   netti della tabella al §1 sono calcolati per una posa a **un tick** dal mid, dove il punteggio
   vale `S = ((4,5−1)/4,5)² = 0,605`. Alla distanza vera di **3,0¢** il punteggio è **0,111**, cioè
   **5,4 volte più basso** — quindi i netti veri sono peggiori di quelli misurati, e i cinque
   `netto-negativo` lo sono **di più**, non di meno. **La stima e l'esecuzione non concordano**, ed è
   la classe «due strade che rispondono alla stessa domanda con numeri diversi».
2. **La selezione e il piano usano criteri diversi.** La selezione ordina per
   `levels[].grossRewardDay` (§4.13) e **non applica il payback**; il piano applica il netto completo.
   Per questo la selezione riempie 12 slot con mercati che il piano poi rifiuta: **non è un difetto
   di uno dei due, è che nessuno dei due conosce il verdetto dell'altro.** È la causa strutturale del
   capitale fermo, ed è più grande di §5.2 p.55.
3. **La ricostruzione del piano non viene persistita**: `realloc-ultimo-piano.json` è fermo a
   `04:42:49Z` mentre il giornale dichiara una ricostruzione ogni due minuti.
4. **Il giornale riporta `righe: N` senza i motivi degli scarti** — il degrado è silenzioso lì, non
   nel piano (che i `reasonCode` li ha).
5. **La suite scrive nello stato di produzione** (dal referto precedente, invariato).

## Cosa servirebbe davvero, se l'obiettivo resta l'80%

In ordine di quanto è dimostrato:
1. **Allineare selezione e piano sullo stesso netto** (difetto 2). Senza, qualunque numero di slot si
   riempie di mercati che il piano rifiuta, e il capitale resta fermo a prescindere dal cap.
2. **Correggere l'offset del piano da 1¢ a 3,0¢** (difetto 1), o i netti resteranno ottimistici.
3. **Solo allora** alzare il cap: a $2.412 il conto dà l'80,0%, e la cassa residua ($295) resta sopra
   i $250 del gradino 1 del §7.

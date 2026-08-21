# D-C · il figlio del pianificatore andava in OOM — diagnosi, simulazione, riparazione

21 agosto 2026. Causa accertata in `data/ricerca/frontiera-5-dollari-21-agosto.md` §13, non ridiscussa.

## 1 · DOVE ANDAVA LA MEMORIA — misurato, non stimato

`scripts/rewards-replay/lib/journal.js` `loadJournal`, l'unico lettore del giornale di agent34 nel
percorso del piano (`allocator.js:1380`, dentro `planFromCollection`). **Tre strutture**, in ordine
di peso (`data/ricerca/d-c-dove-va-la-memoria.json`):

| # | struttura | dimensione | natura |
|---|---|---|---|
| ① | **`byMarket`** — la copia RITENUTA, `{ ...r, tsMs }` (`:52`) | **486 MB** (574.972 righe × **887 B**) | ritenuta per tutta la vita del figlio |
| ② | **`content`** — `readFileSync(file,'utf8')` per file | fino a **283 MB** | transitoria, ma per file |
| ③ | **`content.split('\n')`** — l'array delle righe | altri **~283 MB** | **coesiste** con ② |

Picco ricostruito: `486 + 283 + 283 ≈ 1.052 MB`, contro l'OOM osservato a **924 MB** — V8 muore prima
di toccare il picco vero. Coerente.

**La crescita NON è lineare nei candidati: è lineare nelle RIGHE**, cioè nei campioni nel tempo.
575.000 righe su 7 file, ~5.000 righe per mercato su 114 mercati ⇒ **4,5 MB per mercato** con la
copia grassa, **1,2 MB per mercato** con quella magra. È il numero per il §5.

### Perché le righe sono diventate enormi, e la data coincide

| giorno | mid-history |
|---|---|
| 15/08 | 99,0 MB |
| 16/08 | 167,0 MB |
| 17/08 | 129,0 MB |
| 18/08 | **147,9 MB** |
| **19/08** | **252,5 MB** ← il campo `no` entra in servizio (§5.2 p.43) |
| 20/08 | **282,8 MB** |
| 21/08 | 217,1 MB (parziale) |

`+91%` fra il 18 e il 20. **L'ultimo piano pesante riuscito è del 19/08 alle 15:25.** §5.2 p.43 lo
aveva perfino previsto («la riga quasi raddoppia, ~148 → ~285 MB/g») — mancava chi tirasse la riga
fino al pianificatore.

### La composizione di una riga, campo per campo (campione 1.276 righe, media 3.282 B)

| campo | B/riga | % | serve al piano? |
|---|---|---|---|
| **`no`** | 1.483 | **45,2%** | **no** — gemello NO del book, aggiunto il 19/08 per R4 |
| **`levels`** | 1.318 | **40,1%** | **no** — e il repo lo sapeva già (v. sotto) |
| `tokenIdYes` | 79 | 2,4% | sì |
| `tokenIdNo` | 79 | 2,4% | no |
| `marketId` | 68 | 2,1% | sì |
| gli altri 10 campi | ~71 | 2,2% | sì |

**`no` + `levels` = 85,3% del testo di ogni riga, e nessun consumatore di righe di giornale li legge.**
Verificato: tutte le occorrenze di `.levels` nel percorso del piano sono su oggetti **curva** del
knapsack (`allocator.js:457,542,564`, `allocate.js:243,264,474`), non su righe.

> **⚠ Il repo aveva già preso metà della decisione, nel posto sbagliato.**
> `allocator.js:1407` fa `for (const rows of J.byMarket.values()) for (const r of rows) r.levels = undefined;`
> — cioè sapeva che `levels` è scartabile — **ma DOPO che `loadJournal` ha costruito tutto**, cioè
> dopo il picco. Liberare dopo aver allocato non serve a niente quando è l'allocazione a uccidere.

## 2 · PERCHÉ NESSUNO REAGIVA — il padre distingue nel GIORNALE, non nel COMPORTAMENTO

`calcolaPianoFuoriProcesso` (`agent41:568`) **rifiuta** correttamente: niente piano parziale, niente
piano vecchio. Il problema è a valle, in `lib/maker/realloc-cycle.js:255-261`:

```js
try { piano = await deps.makePlan({...}); }
catch (e) {
  traccia('piano', 'fallito', { error: e.message });
  if (!triggerValidita) return mancato('piano', `il calcolo del piano è fallito (${e.message})`);
  return referto('fermato', `...: nessun ordine viene toccato`, { verdetti });
}
```

- **`triggerValidita` VERO** (c'era un reset in ballo) ⇒ `referto('fermato', …)`: rumoroso e distinto.
- **`triggerValidita` FALSO** (il caso di tutti i giorni) ⇒ `mancato(…)` ⇒ **`referto('nessuna', …)`**,
  cioè **lo stesso `esito` di «non c'era niente da fare»**.

Nel record la differenza c'è (`valore: {misurabile: false, fase: 'piano'}` e la traccia
`piano/fallito`), ma **nessuna difesa reagisce a `misurabile: false`**, e l'esito è condiviso.

> **⚠ E IL RAMO SCELTO CONTIENE UN FAIL-OPEN.** Il commento dichiara: «quando il primo trigger non è
> scattato, un ingresso mancante non è un guasto da urlare — non stava per succedere niente». Ma
> **«non stava per succedere niente» è esattamente ciò che il figlio morto ha impedito di sapere**:
> dopo `mancato()` il ciclo ritorna, quindi `confrontoDiValore` — il SECONDO trigger — non gira mai.
> Un trigger **non misurato** viene trattato come un trigger **non scattato**. È la famiglia
> `Number(null) === 0` di §5.3, in forma di flusso di controllo.
> **Nominato come difetto D-I, NON corretto**: cambiare la tassonomia degli esiti del ciclo è un
> secondo lavoro con un suo rischio, e con l'OOM chiuso il caso diventa raro.

## 3 · IL COSTO in 47 ore — limiti inferiori, dichiarati come tali

| | |
|---|---|
| cicli pesanti falliti | **8 su 8** (19/08 21 · 20/08 03-09-15-21 · 21/08 03-04-10), 4 al giorno |
| ultimo piano pesante salvato | **19/08 15:25** ⇒ **48,7 h** su un piano vecchio |
| `confrontoDiValore` mai misurato | **8 volte su 8** — il trigger di VALORE non è mai stato valutato |
| `collector-priority` in decadimento | da **60 a 40** mercati · **39 scaduti**, **2 freschi** |
| gradini della scala di sblocco (48 h) | `ricostruisci-piano` 13 · `ricarica-configurazione` 13 · `riconcilia-esposizione` 11 · `ripara-precondizioni` 11 · `risveglia-feed` 11 |
| **gradino 6 «fermati-in-sicurezza»** | **avrebbe messo il bot su FERMA 10 volte in 48 h** |

> **⚠ ATTRIBUZIONE ONESTA, perché è facile sbagliarla.** La scala di sblocco parte per **capitale al
> lavoro al 17,9%**, e QUELLO è strutturale — 5 slot × $61,25 = $306 su $1.494,78 di capitale — non
> è colpa dell'OOM. Il contributo dell'OOM è che **il gradino 1 (`ricostruisci-piano`) non può
> riuscire**, quindi la scala non si ferma presto e arriva **ogni volta fino a 6**. Solo
> `SBLOCCO_GRADINO6_ARMATO=0` ha impedito 10 FERMA senza riarmo automatico in due giorni.

**Spodestamenti mancati e premio perso: NON misurabili con precisione**, e non li invento. Il netto
che ordina la selezione arriva da un figlio **diverso e più piccolo** (`onlyMarketIds`, ~20 mercati),
che **non** va in OOM — quindi la selezione ha continuato a ruotare (12 spodestamenti nelle 24 h
precedenti). Ciò che si è perso è il **trigger di valore** del ciclo da 6 h e la **freschezza del
piano salvato**, non la rotazione.

## 4 · LA RIPARAZIONE — tre cambi, nessuna soglia alzata

Tutti in `scripts/rewards-replay/lib/journal.js`, più una riga di cablaggio in `allocator.js:1405`.

| # | cambio | effetto |
|---|---|---|
| ① | **filtro dei file per NOME** (`fileNellaFinestra`) — si leggono solo i giorni che intersecano la finestra, con **1 giorno di margine per lato** | 7 file → **4** sulla finestra di 48 h |
| ② | **streaming a chunk da 4 MB** (`perOgniRiga`) invece di `readFileSync` + `split` | il transitorio non dipende più dal file: ~566 MB → ~4 MB |
| ③ | **`scartaCampi`, OPT-IN**: la copia magra si COSTRUISCE, non si sfoltisce | `['levels','no']` passato solo dall'allocatore |

**⚠ `--max-old-space-size` NON è stato toccato**, come richiesto: alzarlo su una macchina con ~430-660
MB liberi sposterebbe l'OOM killer su agent40/agent41, cioè sui processi che tengono gli ordini veri.

**⚠ Lo scarto è OPT-IN e per questo la corsia del backtest non cambia**: `scartaCampi` assente ⇒
comportamento **identico** (§5.2 p.50). Provato: **145.470 confronti campo-per-campo, 0 divergenze**.

**⚠ Una trappola che ho introdotto io e corretto**: la prima stesura dello streaming usava
`buf.toString('utf8')`, che spezza un carattere multi-byte a cavallo di due chunk — la riga sarebbe
diventata JSON non valido e finita in `malformed`, cioè **un dato perso in silenzio**. Corretto con
`StringDecoder`. Oggi le righe sono ASCII, ma «oggi è ASCII» non è un invariante imponibile.

### La misura, sulla finestra vera del ciclo pesante (48 h)

| variante | file | righe | esito | picco |
|---|---|---|---|---|
| **prima** (tutti i file, campi interi) | 7/7 | ~575.000 | **OOM** | **924 MB** |
| solo ① filtro file | 4/7 | 251.908 | **ANCORA OOM** a cap 650 MB | > 650 MB |
| **① + ② + ③ (applicata)** | **4/7** | **251.904** | **riuscito in 29-33 s** | **302 MB** |

**Nessuno dei due cambi basta da solo: il filtro sui file da solo va ancora in OOM.**

## 5 · DIMENSIONAMENTO PER IL BOARD ALLARGATO

Il picco è governato dalle **righe di giornale**, cioè dai mercati che **agent34 sottoscrive**, non
dai candidati del board. Oggi: **251.904 righe / 657 mercati** in 48 h ⇒ **~0,46 MB per mercato**
(302 MB / 657).

| mercati nel giornale | picco stimato | margine sui 663 MB liberi |
|---|---|---|
| 657 (oggi) | **302 MB** *(misurato)* | 361 MB |
| 900 | ~414 MB | 249 MB |
| 1.200 | ~552 MB | 111 MB |
| **1.440** | **~663 MB** | **ZERO — è il limite** |

**Risposta netta: regge 150 candidati di board con ampio margine; NON regge 1.556.** Il tetto della
corsia calda (`collector-priority`, 60 mercati) e la ritenzione di `mid-history` restano i due
governatori. Alzare il board a 150 non muove questo picco — muove i mercati **sottoscritti**, e
quelli passano dal tetto di 60. **Il prossimo passo, se si vuole andare oltre, è la ritenzione del
giornale (`MID_HISTORY_RETENTION_DAYS`), non il tetto del board.** Non toccata.

## 6 · IL PADRE E GLI ORDINI — nessun processo va riavviato

- File toccati: **`scripts/rewards-replay/lib/journal.js`** e **`lib/rewards/allocator.js`**.
- `journal.js` ha **un solo importatore in produzione**: `allocator.js:1380`, e il `require` è
  **dentro `planFromCollection`**, cioè eseguito nel FIGLIO.
- **agent41 non ha nessun `require` reale** né di `allocator` né di `journal`: l'unica occorrenza
  (`:518`) è **un commento**, e `PERCORSO_ALLOCATOR` è una **stringa** passata a `node -e` (§5.3
  avverte esattamente di questo: «la differenza è fra "serve un riavvio" e "non serve"»).
- **agent40 non tocca nessuno dei due.**

> **⇒ NESSUN RIAVVIO. La correzione entra in servizio da sola**, perché il piano nasce in un processo
> figlio che rilegge il codice da disco a ogni giro (§5.3). **Nessun ordine può diventare
> PRE-ESISTENTE**, perché agent40 non viene toccato.

## 7 · `collector-priority` — non era fermo, stava DECADENDO

**Cosa fa**: è la «corsia calda». Elenca i mercati che agent34 deve sottoscrivere sul websocket
(tetto **60**), e il feed ws è l'unica fonte che rende la profondità **verificata**; un mercato con
profondità `non-verificata` viene **scartato dall'allocatore** (§4.4). È l'anello di §5 p.119.

**Cosa abbiamo perso**: il percorso normale che lo riscrive è `agent41:686`, **dentro `calcolaPiano`,
dopo `await calcolaPianoFuoriProcesso`** — quindi con il figlio morto non ci si arriva mai. A tenerlo
in vita è rimasto solo `agent41:3621`, cioè il **gradino 5 `risveglia-feed`** della scala di sblocco,
che lo riscrive da `leggiUltimoPiano()` — **il piano di 48 ore fa**. Effetto misurato: la lista è
scesa da **60 a 40** mercati, con **39 voci scadute** e **2 sole fresche**.

**Riparte da solo?** **Sì.** `calcolaPiano` lo riscrive al primo ciclo pesante che riesce. **Nessun
intervento separato richiesto** — e infatti non ne è stato fatto nessuno.

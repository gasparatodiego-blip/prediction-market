# Referto — «Porta il capitale al lavoro sopra l'80%»
**23 agosto 2026, 09:45Z.** Misure prima, applicazione dopo, stesso giro.
Commit `ce26a1d`. Riavviati **agent24** (pid 877113) e **agent41** (pid 877107). **agent40 NON riavviato ⇒ zero ordini toccati.**

> ## ⛔ LA RISPOSTA CORTA: L'80% NON È RAGGIUNGIBILE SENZA SFONDARE IL CAP, E IL CAP NON È STATO TOCCATO.
> Il soffitto strutturale è **51,0%**. Mancano **$431** di nozionale, cioè **28,9 punti**.
> Il conto è al §3 e non dipende da quanti slot o da quanto grande sia la size.

---

## 1 · IL TETTO DI SCANSIONE — 300 → **343**, non 382

**Il 382 è reale ma è l'istantanea del ciclo migliore.** Quattro cicli consecutivi del 23/08 fra le
08:15 e le 09:00 danno un ritmo di **2,29 · 1,41 · 1,66 · 1,45 s/mercato** — variazione **1,6×** — e
il tetto che ognuno *dichiarava* era `~235 · ~382 · ~326 · ~371`. Un quinto ciclo misurato dopo
conferma il peggiore: **11,4 min per 300 = 2,29 s/mercato ⇒ ~235**.

**E il conto per-mercato ignora l'overhead.** Durata VERA del ciclo intero, da «scanning…» alla
scrittura del board:

| ciclo | totale | profondità | resto |
|---|---|---|---|
| 08:15:32 → 08:24:29 | 537 s (8,9 min) | 426 s | 111 s |
| 08:30:32 → 08:40:46 | 614 s (10,2 min) | 498 s | 116 s |
| 08:45:32 → 08:54:42 | 550 s (9,2 min) | 438 s | 112 s |

⇒ **overhead di scoperta+scrittura ~113 s, stabile.**

**Il ciclo a 382**: a 1,41 s/mkt ⇒ 10,9 min ✔ · a 1,66 ⇒ 12,4 ✔ · a 1,45 ⇒ 11,1 ✔ ·
**a 2,29 ⇒ 16,5 min ✘ SFORA** il periodo di 15 min.

**Il massimo che ci sta anche nel caso peggiore**: `N = (900 − 113) / 2,29 = **343**`.
Verificato sui quattro ritmi: **15,0 · 9,9 · 11,4 · 10,2 min**. Nessuno sfora.

**⚠ Sforare non rompe, degrada in silenzio** — ed è la ragione per cui si tara sul peggiore:
`resto = SCAN_INTERVAL_MS − durata` ha un pavimento di 60 s, quindi un ciclo da 16,5 min produce un
board ogni ~17,5 min, che sta **sotto `ETA_BOARD_MAX_MS` (25 min)** e non fa scattare nessun allarme.

**In servizio, verificato**: `Processing top **343** of 1273 reward markets` (log delle 09:29:23Z).
Il modulo espone `MAX_CLOB_MARKETS = 343`.

**⚠⚠ LA COPERTURA RESTA PARZIALE: il numero vero dei premiati NON È NOTO.** Il log dichiara a ogni
giro `4-5 fette al tetto dei 2.100 · budget fette esaurito a 120p` (`REWARD_FAST_MAX_PAGES`), quindi
il **1.273-1.281** che compare come totale è un **limite inferiore**, non un censimento. Alzare
questo tetto fa vedere più mercati **fra quelli trovati**; non fa trovare quelli mai cercati.

## 2 · LA QUOTA «BASSO» — 1 → **4** su 12

`quotaScaglioni` dà ora `round(N/3)`, almeno 1 e al più N−1: **a N=12 fa 4+8**, a N=3 fa ancora
**1+2** (la regola originale dell'operatore, intatta).

**Misurato PRIMA, sul board delle 09:04Z**: dei **22 mercati ammissibili e liberi**, **14 sono
«basso»** (12 lunghi + 2 corti) contro **un posto solo, già occupato** — quattordici candidati che
non potevano entrare mai, qualunque cosa succedesse.

**⚠ QUANTI NE RIENTRANO SUBITO: ZERO, e va detto.** Gli slot erano già **12/12**. La quota non crea
slot: cambia **chi** li occupa quando si liberano. Misurato prima del cambio:
- quota basso 1 ⇒ posti liberi `basso 0 · alto 0` ⇒ entranti possibili **0**
- quota basso 4 ⇒ posti liberi `basso 3 · alto 0` ⇒ entranti possibili **3**, ma `slotLiberi = 0`

E il referto post-riavvio lo conferma: `postiNonAssegnati: [{scaglione: basso, posti: 3}]` con
`occupati 12`. **I 3 posti «basso» esistono e aspettano che uno slot si liberi.**

**⚠ NON EVICE NESSUNO.** Con 11 occupanti «alto» e la quota nuova a 8, `postiLiberi` va **negativo**
e il cancello legge `> 0`, cioè «pieno»: nessuno viene cacciato. La composizione nuova si realizza
man mano, non con uno strappo — cacciare un mercato che sta quotando bene per una ragione di
composizione sarebbe churn pagato in priorità di coda.

## 3 · IL TETTO PER MERCATO — **non toccato**, e il conto dice perché

```
equity totale            = $1.464,47 + $24,63            = $1.489,10
obiettivo 80%                                             = $1.191,28 al lavoro
alLavoro = totale − libero = totale − (saldo − nozionale) = posizioni + nozionale
  ⇒ nozionale necessario = $1.191,28 − $24,63            = $1.166,65

IL VINCOLO DEL CAP, in forma generale:
  esposizioneMassimaRaggiungibile(N) = N × 2 × tetto ≤ cap
  ⇒ N × tetto ≤ cap/2 = $735,00
  e il nozionale a riposo È N × tetto     ⇒  nozionale ≤ $735,00
```

**⚠ Il soffitto NON dipende da N.** Qualunque coppia `(N, tetto)` dà lo stesso $735: più slot con
size più piccola, o meno slot con size più grande, **producono lo stesso nozionale massimo**. Non
esiste una configurazione che arrivi all'80% sotto un cap di $1.470.

```
capitale al lavoro MASSIMO = $24,63 + $735,00 = $759,63 = 51,0%
MANCANO                    = $431,65 di nozionale = 28,9 punti percentuali

il tetto che servirebbe, a N=12: $1.166,65 / 12 = $97,22
  verifica: 12 × 2 × $97,22 = $2.333,30  contro cap $1.470  ⇒ SFONDA di $863,30

il tetto MASSIMO che rispetta il cap a N=12 = $1.470 / 2 / 12 = $61,25
  ⇒ È ESATTAMENTE QUELLO DI ADESSO. Non c'è niente da alzare.
```

**Punto 3 non applicato. Punto 4 rispettato: il cap resta $1.470.**

## 5 · L'ORDINE DELLE MOSSE, come chiesto

1 e 2 applicati per primi → riavvio → atteso il ciclo di selezione (09:33:18Z) → misurato: **12/12
slot, 2 corti su 2, 10 lunghi su 10, `entranti 0`, `postiNonAssegnati [{basso,3}]`** → **solo allora**
calcolato il punto 3 sul numero reale, che dice **non applicabile**. Il tetto per mercato non è stato
toccato.

## 7 · I MERCATI FERMI — sono QUATTRO, non tre, e il blocco è il PIANO

| mercato | scaglione | fermo da |
|---|---|---|
| `0x684e5b72` NVIDIA | alto | **236 min** |
| `0xf3c634bd` Musk <40 tweet | alto | **208 min** |
| `0x5e082f0b` Fed 1 taglio | alto | 15 min |
| `0x4e4f77e7` Republican House | alto | 15 min |

**Non è un rifiuto di un gate**: cercati tutti i `manual-place`, `bulk-allocate` e `rifiuto-ripetuto`
su quei quattro mercati nelle ultime 4 ore ⇒ **nessun tentativo di piazzamento, zero record**.

**Il blocco è a monte: il piano ha 4 righe su 12 mercati selezionati.**
`data/realloc-ultimo-piano.json` porta **4 righe** e il giornale ripete a ogni mini-ciclo
`ricostruzione: {tentata: true, adottata: true, righe: 4}` con esito
`nessun mercato del piano ha spazio sufficiente adesso`. I mercati selezionati che non ricevono una
riga di piano non ricevono mai un ordine.

**È §5.2 p.55**: l'allocatore scarta chi ha `profondita: 'non-verificata'`, e la verifica accetta
**solo campioni websocket** — la corsia di agent34 ha un tetto di 60 posti. **Difetto dichiarato,
NON corretto in questo giro**, come richiesto.

## 8 · ORDINI VIVI, dichiarati PRIMA del riavvio

16 ordini a riposo su 8 mercati, **$423,89** · 6 coppie · **2 gambe scoperte a libro** · **2
posizioni aperte** (`0x4d79d306` 56,1 @0,386 carico 0,494 · `0xd947c421` 56,1 @0,053 carico 0,065),
**non vendute**. Riavviati **agent24** (tetto di scansione) e **agent41** (quota). **agent40 NON
riavviato**, perché nessuna delle due modifiche vive lì ⇒ **zero ordini toccati**.
Il riavvio di agent41 **ha azzerato la quarantena slot-sterile in memoria**: ne sono usciti 6 —
`0x684e5b72` NVIDIA, `0xf3c634bd` Musk<40, `0x5e082f0b` Fed-1-taglio, `0x4e4f77e7` Republican-House,
`0x80b3af88` Fed-rialzo, `0xd4e77ba6` no-Fed-cuts.

## 9-10 · ASSERZIONI E SUITE

`lib/maker/scansione-e-quota.test.js` — **18/0**, **ROSSO su HEAD con 8 fallimenti**:
- un board di **400 righe** viene valutato **tutto** (`valutati === 400`), e con ≥382 ammissibili la
  selezione li considera tutti;
- il tetto configurato **sta nel periodo al ritmo peggiore**, col **CONTROLLO** che 382 non ci starebbe;
- con quota basso 4 e ≥4 candidati «basso» entrano **esattamente 4**, e i 2 in eccesso escono con
  `quota-scaglione-piena`;
- la quota **non muove il capitale**: `esposizioneMassimaRaggiungibileUsd(N)/2/N === 61,25` per ogni N.

**Quattro test asserivano il comportamento vecchio e sono stati RISCRITTI SULLA PROPRIETÀ, non
ammorbiditi**: `vista-board` (`MAX_CLOB_MARKETS === 300` era una fotografia della costante — ora
difende «non più stretto di 150» **e** «sta nel periodo al ritmo peggiore»), `selezione-mercati`
(`basso === 1` idem — ora difende «esiste sempre e non mangia mai tutto l'alto», più il caso N=3),
`fasce-slot` ② e ③ e `distanze-e-slot` ⑦ (i fixture erano tutti «alto», quindi a fermarli sarebbe
stata la quota invece della fascia — che è ciò che quei blocchi provano).

**Suite: `252 test · 243 verdi · 8 ROSSI · 1 non parte`** — esattamente gli 8 noti.
`allowlist-con-posizioni` è tornato verde da solo: era dipendente dallo stato vivo, come previsto.

## 11 · DOPO DUE CICLI

| | |
|---|---|
| ordini a riposo | **16** |
| mercati con ordini | **8** su 12 assegnati |
| slot occupati | **12 su 12** — 10 lunghi (su 10) + 2 corti (su 2) |
| posti non assegnati | `[{scaglione: basso, posti: 3}]` — la quota nuova aspetta uno slot libero |
| size per lato | **$26,49** · per mercato **$52,99** (tetto $61,25) |
| nozionale | **$423,89** |
| capitale al lavoro | **$448,52 / $1.489,10 = 30,1%** |
| soffitto strutturale | **$759,63 = 51,0%** |

## Difetti trovati e NON corretti

1. **Il piano produce 4 righe su 12 mercati selezionati** (§7 sopra, §5.2 p.55). È la causa vera per
   cui il capitale al lavoro sta al 30% invece che al 49% raggiungibile: quattro slot assegnati non
   hanno mai ricevuto un ordine, due da oltre tre ore.
2. **La suite scrive nello stato di produzione**: il runner dichiara `⚠ STATO TOCCATO:
   data/selezione-mercati.json`, e durante l'esecuzione compaiono nel giornale record
   `tipo: 'selezione-mercati'` con `valutati: 143` e `fasce: null` che **non vengono da agent41**.
   È §5.2 p.45 in forma peggiore: non solo il rilevatore non distingue l'autore, ma i test **scrivono
   davvero** nel giornale di produzione.
3. **La quarantena non compare in nessuna lista di scarto** (§5.2 p.62), invariato.

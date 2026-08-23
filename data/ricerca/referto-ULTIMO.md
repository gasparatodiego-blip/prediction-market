# Referto — «Applica il cap e riempi gli slot»
**23 agosto 2026, 11:42Z.** Verifica **prima**, applicazione **dopo**, nello stesso giro.
Commit `186af96`, pushato. Riavviato **solo agent41**.

> ## ✅ APPLICATO — cap **$2.400**, slot **18** su un soffitto di **19**
> ## ⚠️ E NON HA PORTATO IL CAPITALE ALL'80%: il cap e gli slot **non erano il vincolo**
> Gli slot sono passati da 12 a 18 e si sono **riempiti tutti** (18/18, zero slot vuoti per
> scarsità). Ma il **piano** finanzia **4 righe su 17 attive**: 13 mercati selezionati non
> ricevono un dollaro, e le ragioni sono le stesse già misurate alle 10:02 — `netto-negativo`
> (6), `quota-coda-lunga` (6), `orizzonte` (1). **Capitale al lavoro 46,0%**, contro il 48,8%
> di prima del giro. **Il collo di bottiglia non era il tetto di esposizione.**

---

## 1 · LA VERIFICA CHIESTA AL PUNTO 1 — **sì, era già fatto**, e con file e riga

L'allineamento è il commit **`3ce2256`** del **23/08 10:39:15Z**, **in servizio da 13 secondi
dopo**: agent41 pid 883101 è partito alle **10:39:28Z**.

| cosa | dove | valore misurato |
|---|---|---|
| la distanza del piano | `agents/agent41-realloc-scheduler.js:649` — `conDistanzaDiPiano(o)` mette `offsetTicks: null` + `offsetCents` da `distanzaObiettivoCents` | **3,00¢** |
| il piano **operativo** ci passa | `agent41-realloc-scheduler.js:696` (`calcolaPianoFuoriProcesso`) | ✅ |
| il piano dei **netti che ordinano la selezione** ci passa | `agent41-realloc-scheduler.js:1487` (`nettiDeiCandidati`) | ✅ |

Misurato con la `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V` **del processo vivo** (0,6666…):
`distanzaObiettivoCents({maxSpreadCents: 4.5})` = `{"distanzaC":3,"motivo":"obiettivo
0.6666… × v(4.5¢) = 3.00¢ dal mid"}`. **I 18 mercati sono stati scelti con i netti a 3,0¢**,
non con quelli a 1 tick. ⚠ Resta vero ciò che `3ce2256` dichiarava: la correzione **non muove
i netti** (il lordo nasce da `levels[]` del board, calcolato da agent24 con la propria posa).

## 2 · IL CAP — e il **secondo tetto** che il punto 2 non contava

`maxOpenNotionalUsd` **$1.470 → $2.400** in `data/safety-risk-limits.json`.
⚠ **Il cap non si legge da `/proc`**: non è un env, è il file **versionato**. Da `/proc` si
legge il numero di **slot**. Il punto di configurazione è uno, ma non è dove diceva il punto 2.

⚠⚠ **E non bastava**: `lib/safety/risk-limits.HARD_CEILINGS.maxOpenNotionalUsd` stava a
**$2.000**, e `clampNum` fa `min(disco, tetto duro)` **senza sollevare**. Il cap in servizio
sarebbe stato **$2.000** mentre il referto diceva $2.400 — e l'invariante a N=19 ($2.327,50)
sarebbe stata **verificata su un numero e applicata su un altro**: il gate avrebbe smesso di
piazzare a metà strada (il guasto del 16 agosto), col referto che rassicura. Il tetto duro sale
allo **stretto necessario** ($2.400), quindi resta un tetto vero.
**Verificato dopo il riavvio**: `resolveLimits()` ⇒ `maxOpenNotionalUsd: 2400`, `clampEvents: []`.

## 3 · GLI SLOT — **18**, non 19, e la ragione è la **cassa** (punto 4)

```
IL CAP autorizza 19:   19 × 2 × $61,25 = $2.327,50  ≤ $2.400
                       20 × 2 × $61,25 = $2.450,00  > $2.400   ⇒ NO
LA CASSA autorizza 18: saldo agent41 10:58:36Z = $1.391,57
      19 × $61,25 = $1.163,75 ⇒ residua $227,82   ← SOTTO il pavimento di $250
      18 × $61,25 = $1.102,50 ⇒ residua $289,07   ← sopra ⇒ in servizio
```
Il punto 4 dice esattamente questo («se scende sotto, riduci N»). **Il $1.464,47 del referto
delle 12:12 era più alto del saldo che agent41 legge**, e le due grandezze non sono la stessa
cosa: il cap limita l'**esposizione**, la cassa è il denaro con cui si comprano le sorelle.
Perciò il **soffitto** di sorgente vale **19** (ciò che il cap autorizza) e **l'ambiente vale
18** (ciò che la cassa consente). Sopra $1.413,75 di saldo il 19 diventa scrivibile.

⚠ **E il soffitto andava mosso o il 18 sarebbe stato rifiutato in silenzio**: `quantiMercati`
risponde col **difetto**, non con un errore, quando il valore supera
`selezione-mercati.MAX_MERCATI_CONTEMPORANEI` — lo stesso blocco del 18 e del 22 agosto.

**Composizione DERIVATA**: `quotaScaglioni(18)` = `round(18/3)` = **6 «basso» + 12 «alto»**.
**Quanti dei candidati «basso» sono entrati davvero**: alle 11:26:49Z
`scartatiPerComposizione` è **vuoto** e `postiNonAssegnati` è **vuoto** — nessun candidato è
stato respinto dalla quota, e nessun posto è rimasto non assegnato. Il secchio «basso» non è
più il cancello che era il 22/08 (6 scarti `quota-scaglione-piena`).
`MAKER_SLOT_CORTI` resta **2** (2 corti + 16 lunghi): asse ortogonale, non toccato.

## 4 · LA CASSA (punto 4) — **$1.438,72**, molto sopra $250

A piena allocazione (18 × $61,25 = $1.102,50) resterebbero **$289,07**. Oggi il piano ne
alloca $189, quindi la cassa reale è $1.438,72. **Nessuna riduzione ulteriore di N necessaria.**

## 5 · GLI SCARTI RESTANO SCARTI (punto 5) — **nessun netto negativo forzato dentro**

**Zero slot vuoti**: 18/18 occupati, `slotVuotiPerScarsita: null`. Ma **17 attivi ⇒ 4 righe di
piano**, e i 13 senza riga (misurati alle 11:37Z col piano vero, distanza 3,0¢):

| ragione | mercati | capitale fermo |
|---|---:|---:|
| `netto-negativo` | **6** (`0x12dc2b61` `0xf3c634bd` `0xdeb729bc` `0xa34edb6c` `0xd4e77ba6` `0x80b3af88`) | **$367,50** |
| `quota-coda-lunga` | **6** (`0x76c1a69f` `0x684e5b72` `0x14d32732` `0x5e082f0b` `0x4e4f77e7` `0x938e6a0a`) | $367,50 |
| `orizzonte` | 1 (`0x7619b095`) | $61,25 |
| **totale non finanziato** | **13** | **$796,25** |

**$367,50 restano fermi per netto negativo, e non è un difetto**: un mercato che rende meno di
zero resta fuori anche se occupa uno slot. **Nessuno è stato forzato dentro.**
⚠ **Ma la voce più grossa non è quella**: `quota-coda-lunga` (il 12% del piano oltre 7 giorni,
§4.4) ne ferma altrettanti, e **il cap non la tocca**. È la stessa diagnosi del referto delle
10:02, e **alzare cap e slot non l'ha cambiata**.

## 6 · NON TOCCATO (punto 6)
tetto per mercato **$61,25** · soglia **24 h** · filtro meteo · distanze (lunghi **3,0¢**,
corti **3,5¢**) · tetto coppia **101¢** · payback · pavimento di profondità · guardiano ·
kill R10 · Parte B · fix OFF_TICK. **Le posizioni aperte non sono state vendute.**

## 7 · ORDINI VIVI E RIAVVIO (punto 7) — dichiarato **prima**

| | prima (11:13Z) | dopo (11:41Z) |
|---|---|---|
| ordini a riposo | **21** su **11** mercati (10 coppie + 1 gamba) | **26** su **13** mercati |
| posizioni aperte | **4**, valore **$92,82** | **3**, valore **$49,61** |
| gambe scoperte | le 4 posizioni erano tutte a lato singolo | 3 |
| capitale a riposo | $631,45 | **$635,73** |

**Riavviato un processo solo: `agent41-realloc-scheduler`** (pid 883101 → **890013**, 11:14:30Z),
`pm2 restart agents/ecosystem.config.js --only agent41-realloc-scheduler` + `pm2 save`.
**Ordini toccati dal riavvio: ZERO** — la regola dei PRE-ESISTENTI è di **agent40**, che non è
stato riavviato apposta: riavviarlo avrebbe condannato i 21 ordini a libro alla morte per GTD.
⚠ **Il riavvio ha azzerato la quarantena slot-sterile in memoria** di agent41 (e con essa
`zeroDa`): non è un disarmo, ma il freno anti-churn riparte da zero.
⚠ **agent40 tiene in memoria `HARD_CEILINGS = $2.000`** fino al suo prossimo riavvio. Oggi non
morde: l'esposizione **riconciliata** è $49,61, e $2.000 comincerebbe a mordere solo sopra 16
mercati interamente riempiti. Si sana da sé al prossimo riavvio di agent40. **Dichiarato.**

## 8 · L'ASSERZIONE (punto 8) — `lib/maker/cap-2400-e-slot.test.js`, **26/0**
**Rossa sul sorgente non corretto: 6 fallimenti**, fra cui esattamente quello chiesto —
`19 × 2 × $61,25 = $2.327,50 ≤ cap $1.470` **FAIL**. Regge a **19**, **morde a 20**
($2.450 > $2.400): senza la metà che fallisce non sarebbe un'invariante ma una tautologia.
Il blocco ② è stato **provato costruendo il caso**: cap $2.400 su disco con tetto duro $2.000
⇒ `FAIL — disco 2400 != servizio 2000: HARD_CEILINGS lo sta tagliando`.

## 9 · LA SUITE (punto 9) — **254 test · 246 verdi · 7 ROSSI · 1 non parte**
`data/ricerca/suite-rossi-23ago-cap2400-finale.json`. **Nessun rosso nuovo.** I 7 sono i noti,
per nome: `dipendenze-mai-iniettate` · `distanza-2c` · `end-of-scale-cycle` ·
`tetti-per-giro-e-scope` · `categoria-mercato` · `tetto-derivato-dallo-scaglione` ·
`tetto-e-scoperta`. **Sono 7 e non 8 perché `tre-fix-sicurezza` è passato** (era il timeout di
§5.2 p.42, non una regressione). **Due rossi chiusi per strada**:
`selezione-cablata` (contava i selezionati invece degli **attivi** — **§5.2 p.61 CHIUSA**; e il
regex che fotografava `restringiAllaSelezione(` nudo, rotto da `3ce2256`) e `limiti-versionati`
(disco ≠ versionato finché il cap non era committato). Commit `186af96`, **push fatto**.

## 10 · IL RIPRISTINO (punto 10)
Riga unica in **`APERTI.md`**, in cima: riporta cap a **$1.470**, slot a **12** e soffitto a
**12** in un comando solo. ⚠ **L'ordine è obbligato**: abbassare il cap lasciando 18 slot
significherebbe $2.205 autorizzati contro $1.470 di tetto, cioè il gate che smette di piazzare
a metà strada. `cap-2400-e-slot.test.js` diventa rosso se qualcuno ne fa solo una.

## 11 · DOPO DUE CICLI (punto 11) — misurato alle 11:41Z, macchina scarica

| grandezza | valore |
|---|---|
| **righe di piano / mercati selezionati** | **4 / 17 attivi** (+3 in gestione, 20 selezionati) |
| capitale allocato dal piano | **$189,00** su $1.438,72 · non allocato **$1.249,72** |
| mercati con ordini al venue | **13** |
| ordini a riposo | **26** |
| nozionale a riposo | **$635,73** |
| cassa residua | **$1.438,72** |
| **capitale al lavoro** | **46,0%** (era 48,8% prima del giro; 36,1% nel mezzo della rotazione) |
| posizioni aperte | 3, $49,61 |

⚠ **L'80% non è stato raggiunto, e adesso si sa perché con i numeri**: gli slot si sono
riempiti (18/18) ma il **piano** finanzia 4 righe. **$796,25 di capitale sta fermo su mercati
selezionati che il piano rifiuta**, e le due voci sono `netto-negativo` ($367,50 — corretto che
resti fermo) e `quota-coda-lunga` ($367,50 — **una decisione dell'operatore, non un difetto**).
Il cap e il numero di slot **non erano il vincolo**, e alzarli non lo ha spostato.

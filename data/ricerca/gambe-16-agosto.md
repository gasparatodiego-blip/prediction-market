# COSA È SUCCESSO AGLI ORDINI DI LIQUIDITÀ IL 16 AGOSTO 2026

Ricostruito il 17 agosto 2026, **sola lettura**, dagli eventi di nascita e di morte degli ordini —
non da quello che il maker dichiarava nei referti. Script: `scripts/ricerca/cronologia-gambe-16-agosto.js`,
dati grezzi in `data/ricerca/cronologia-gambe-2026-08-16.json`.

**Fonte e suo limite, dichiarati.** La fonte più diretta sarebbe `polymarket-clob-audit.jsonl`, che
porta **75.077 `listOpenOrders`** del 16 agosto, cioè la fotografia dello stato vero al venue. Non è
usabile per una cronologia: il `marketId` è **redatto** (`0x[redacted-64hex]`) e la risposta conserva
il solo `count`. Dice *quanti* ordini c'erano, non *dove*. Si usa quindi il giornale maker, che porta
`marketRef: cid_<hex>` **in chiaro** sulle nascite, e i `count` del venue restano come **riscontro
aggregato** (§4-bis). Lo stato è ricostruito campionando a ogni evento, non a tempo fisso: fra due
eventi consecutivi l'insieme degli ordini vivi non può cambiare, quindi non c'è errore di
discretizzazione.

**Definizione operativa.** Una *gamba* è un ordine vivo a riposo su un book (`yes` / `no`).
*Copertura piena* = almeno un ordine vivo su **entrambi** i book nello stesso istante.

**⚠ I riprezzi vanno seguiti, o si conta una morte che non c'è stata.** Un riprezzo è una
cancellazione seguita da un piazzamento: guardando le sole morti, ogni riprezzo sembrerebbe una gamba
persa. Qui la gamba muore quando muore l'**ultimo anello** della catena **senza un successore**.

---

## 0 · IL NUMERO CHE RIASSUME LA GIORNATA

**377 ordini nati su 8 mercati. 133 passaggi da due gambe a una.**

| | ore | quota |
|---|---|---|
| **due gambe vive** (liquidità vera, su entrambi i lati) | **14,70 h** | **50,0 %** |
| **una gamba sola** (esposizione direzionale, mezzo reward) | **7,15 h** | 24,3 % |
| **zero gambe** (dentro la finestra del mercato) | **7,54 h** | 25,7 % |
| somma delle finestre per mercato | 29,40 h | |

Metà del tempo in cui il bot aveva un mercato aperto, faceva il mestiere per cui esiste.

**⚠ Delle 133 cadute, 111 non contano**: durano **3,4 secondi in mediana** (6,2 minuti in tutto) e
sono la finestra fisiologica fra il `cancel` e il `place` di un riprezzo. **Le 22 cadute lunghe
(≥ 1 minuto) valgono 283,0 dei 289,3 minuti totali, cioè il 97,8 %.** Tutto ciò che segue riguarda
quelle: intervenire sulle altre sarebbe rumore.

---

## 1 · LA CRONOLOGIA, MERCATO PER MERCATO

| mercato | ordini | finestra (UTC) | 2 gambe | 1 gamba | cadute | **% piena** |
|---|---|---|---|---|---|---|
| `33ec826f37…` | 187 | 11:14:35 → 19:28:08 | 325,7 m | 36,0 m | 31 | **66,0 %** |
| `de0b0b24bf…` (FL-27) | 74 | 10:46:42 → 18:33:13 | 253,3 m | 169,4 m | 27 | 54,3 % |
| `c9abc0f43d…` | 25 | 17:47:50 → 18:48:17 | 57,2 m | 2,1 m | 21 | **94,7 %** |
| `2aaff186cc…` | 9 | 15:26:03 → 17:29:37 | 46,5 m | 0,4 m | 4 | 37,7 % |
| `776841ce97…` | 26 | 11:14:46 → 13:56:40 | 61,1 m | 8,2 m | 12 | 37,7 % |
| `afb455a592…` | 8 | 16:47:54 → 18:35:23 | 41,2 m | 56,3 m | 5 | 38,3 % |
| `c16fade4bb…` | 17 | 16:32:11 → 18:35:23 | 42,8 m | 68,2 m | 9 | 34,8 % |
| `f2b0c93903…` | 31 | 12:34:14 → 16:21:01 | 54,1 m | 88,7 m | 24 | **23,8 %** |

**I primi ordini veri nascono alle 10:46:42** su `de0b0b24bf…` — coerente con l'armamento di ieri
mattina. **L'ultimo evento è alle 19:28:08.**

### Gli istanti esatti in cui si passa da due gambe a una — le 22 cadute che pesano

| mercato | ora | resta | minuti singola | causa letta dagli eventi | tornata |
|---|---|---|---|---|---|
| `de0b0b24bf…` | 17:30:26 | yes | **31,86** | replace: `nozionale-mercato-oltre-tetto` | 18:02:18 |
| `de0b0b24bf…` | 16:58:28 | yes | **31,75** | replace: `nozionale-mercato-oltre-tetto` | 17:30:13 |
| `de0b0b24bf…` | 18:02:23 | yes | **30,82** | replace: `nozionale-mercato-oltre-tetto` | **MAI** |
| `f2b0c93903…` | 12:58:46 | no | **23,28** | replace: `nozionale-mercato-oltre-tetto` | **MAI** |
| `afb455a592…` | 17:08:28 | no | **19,51** | replace: `doppione-identico` | **MAI** |
| `de0b0b24bf…` | 16:08:06 | yes | 18,27 | `expired` (GTD, 1397 s) | 16:26:22 |
| `de0b0b24bf…` | 16:40:09 | yes | 18,02 | cancellato da `auto-close-on-fill` | 16:58:10 |
| `de0b0b24bf…` | 12:14:42 | no | 17,93 | replace: `nozionale-mercato-oltre-tetto` | **MAI** |
| `afb455a592…` | 18:18:44 | yes | 16,65 | replace: `doppione-identico` | **MAI** |
| `f2b0c93903…` | 12:43:13 | no | 14,63 | replace: `nozionale-mercato-oltre-tetto` | **MAI** |
| `33ec826f37…` | 11:59:20 | yes | 13,15 | `expired` (GTD, 1431 s) | **MAI** |
| `f2b0c93903…` | 15:33:26 | yes | 10,90 | `expired` (GTD, 1391 s) | **MAI** |
| `de0b0b24bf…` | 12:03:23 | no | 9,10 | `expired` (GTD, 1425 s) | **MAI** |
| `33ec826f37…` | 16:17:46 | no | 7,58 | `expired` (GTD, 1415 s) | **MAI** |
| `33ec826f37…` | 13:49:06 | no | 5,51 | replace: `nozionale-mercato-oltre-tetto` | **MAI** |
| `33ec826f37…` | 14:04:27 | yes | 5,05 | replace: `nozionale-mercato-oltre-tetto` | **MAI** |
| `776841ce97…` | 11:37:58 | yes | 2,89 | `expired` (GTD, 1393 s) | **MAI** |
| `f2b0c93903…` | 14:37:22 | yes | 2,01 | `cancelled-externally` (1379 s) | **MAI** |
| `33ec826f37…` | 15:21:46 | no | 1,08 | `expired` (GTD, 1401 s) | **MAI** |
| `de0b0b24bf…` | 14:46:31 | no | 1,02 | `expired` (GTD, 1382 s) | **MAI** |
| `de0b0b24bf…` | 15:19:40 | no | 1,02 | **riempito** (1,82 @ 0,20) | **MAI** |
| `c9abc0f43d…` | 18:42:43 | yes | 1,00 | `expired` (GTD, 1381 s) | **MAI** |

**17 delle 22 non sono mai tornate.** Le 5 che sono tornate lo hanno fatto dopo 18-32 minuti.

---

## 2 · LA CAUSA DI OGNI GAMBA PERSA, PESATA IN MINUTI

Non «quante volte è successo», ma «quanti minuti di gamba singola ha prodotto» — è l'unica misura che
ordina correttamente gli interventi.

| # | causa | minuti | quota | episodi | mercati |
|---|---|---|---|---|---|
| **1** | **riprezzo che cancella e non ripiazza — gate `nozionale-mercato-oltre-tetto`** | **160,8** | **55,6 %** | 11 | 4 |
| **2** | **morta di GTD senza rinnovo (`expired`)** | **65,0** | **22,5 %** | 9 | 5 |
| **3** | **riprezzo che cancella e non ripiazza — gate `doppione-identico`** | **36,2** | **12,5 %** | 7 | 2 |
| 4 | cancellata da `auto-close-on-fill` e non rimessa | 18,0 | 6,2 % | 1 | 1 |
| 5 | sparita fuori dal pannello (`cancelled-externally`) | 2,0 | 0,7 % | 1 | 1 |
| 6 | riempita e non sostituita | 1,0 | 0,3 % | 1 | 1 |
| — | finestre di riprezzo normali (3,4 s in mediana) | 6,2 | 2,1 % | 111 | 8 |

**Nessun minuto è attribuito al pavimento di profondità come causa di morte**, e non è un'assoluzione:
il pavimento non uccide, **impedisce di far rinascere** — è la causa a monte del punto 2, e si legge
nel §3.

### 2a · Le classi che l'operatore aveva elencato, e quale non compare

* **morta di GTD senza rinnovo** → punto 2, **65,0 minuti**.
* **cancellata per mid stantio** → **zero minuti**. Ci sono 46 `mid-stantio-cancellato` nel giornale,
  ma nessuno cade su una caduta lunga: il mid stantio è passato da 20 s a 120 s ieri sera e ha smesso
  di mordere.
* **rifiutata dal pavimento di profondità** → **zero minuti come causa diretta**, ma **2.100 blocchi**
  come causa a monte (308 `anomalia-rinnovo-fermato` + 1.792 `skip-motore-non-conforme`). Vedi §3.
* **riempita e non sostituita** → punto 6, **1,0 minuto**. Un solo fill registrato come tale.
* **cancellata dal lock** → **zero**. Il lock per mercato (`lock-mercato.js`) non ha ucciso nessuna
  gamba: ha prodotto attese, non morti.
* **mai nata perché il piano non l'ha finanziata** → **nessuna**. Vedi la tabella qui sotto: i 285
  rifiuti al piazzamento sono di configurazione e di corsa, non di capitale.

### 2b · Le gambe mai nate — 285 rifiuti al piazzamento, per gate

| n | gate | lettura |
|---|---|---|
| 120 | `live-min-market-unset` | prima dell'armamento: nessun mercato in lista, rifiuto corretto |
| 36 | `end-of-scale` | mercato in risoluzione, rifiuto corretto |
| 24 | `live-min-market-mismatch` | mercato fuori dalla lista abilitata |
| 18 | `stale-book` | book non live, rifiuto corretto |
| **17** | **`nozionale-mercato-oltre-tetto`** | **la stessa causa del punto 1, sul percorso di apertura** |
| 12+12 | `reject-idempotent` / `idempotent-duplicate` | corsa del riprezzo |
| 12 | `reject-venue` | rifiuto del venue |
| 9 | `venue-rules` | fuori banda |
| **7** | **`doppione-identico`** | **la stessa causa del punto 3** |
| 6+6 | `market-unknown`, `manual-mode-inactive` | prove manuali |
| 4 | `funding-approval` | prima dell'attestazione |
| 1 | `mai-primo-sul-libro` | regola di rischio, perdita voluta |

---

## 3 · PERCHÉ NON È TORNATA

### ① Il difetto che pesa di più: **un riprezzo non è un'apertura, ma due gate lo trattano come tale**

`replaceManualOrder` ha **cinque precontrolli prima di cancellare**, tutti con `oldCancelled:false`,
proprio perché una cancellazione senza ripiazzo lascia la gamba scoperta. Sono: kill, orologio del
mercato, regole del venue, **tetto per ordine**, **chiave di idempotenza**
(`lib/maker/manual-order.js:1716-1806`).

**I due gate aggiunti ieri non sono in quell'elenco.** `doppione-identico` (riga **1291**) e
`nozionale-mercato-oltre-tetto` (riga **1316**) vivono dentro `placeManualOrder`, cioè **dopo** la
cancellazione. Il riprezzo quindi:

1. supera i cinque precontrolli;
2. **cancella** il vecchio ordine — la gamba esce dal libro;
3. tenta il piazzamento, che il sesto o settimo gate rifiuta;
4. ritorna `oldCancelled:true, replaced:false` — **e la gamba è persa.**

È la classe **«protezione presente su un percorso e assente sul suo gemello»**, la stessa di §4.8 e
già contata 5+ volte nel registro. **197,0 dei 289,3 minuti — il 68,1 % — vengono da qui.**

**⚠ E c'è un secondo difetto dentro il primo, di segno.** Il gate del nozionale per mercato somma
`ordini a riposo + questo ordine`, che è l'aritmetica di chi **apre**. Su un riprezzo è sbagliata:
l'ordine che si sta sostituendo **è già dentro** gli «ordini a riposo», quindi viene contato due
volte. L'evidenza è nel giornale delle 12:14:42 su FL-27:

> «questo mercato ha già **$53.67** di ordini a riposo **(2)** e questo ordine ne aggiungerebbe
> **$11.42**: il totale $65.09 supera il tetto per mercato di $61.25»

L'ordine che stava per essere ripiazzato valeva $11.42 (0,20 × 57,1) ed era una di quelle 2 righe.
Il sottraendo esiste già nel codice — `aRiposo = Math.max(0, aRiposo − …)` alla riga **1311** — ma si
applica **solo** al ramo della gemella cancellata dentro `placeManualOrder`, non al riprezzo.
**Terza occorrenza della classe «regola nata per limitare l'APERTURA applicata a un'azione che non
apre»** (§5-bis p.133, p.147, p.168).

### ② Il pavimento di profondità impediva il rinnovo — e questo **è già chiuso**

**2.100 blocchi in giornata**: 308 `anomalia-rinnovo-fermato` + 1.792 `skip-motore-non-conforme`,
tutti con motivo `profondita-insufficiente` (della forma «$515.78 su 10 livelli contro $836.08»).
Concentrati su `f2b0c93903…` (267 dei 308).

**Distribuzione oraria dei 308: 11:00 → 41 · 12:00 → 118 · 13:00 → 115 · 15:00 → 34 · dopo le 16:00
→ ZERO.** Il difetto è stato chiuso ieri alle 15:55 (commit `63c10a0`,
`lib/maker/esenzione-rinnovo.js`, CLAUDE.md §5.2 p.21) e agent40 è stato riavviato alle 20:02, quindi
**la correzione è ora nel processo.**

**⚠ Ma non spiega tutto il punto 2**: tre episodi `expired` cadono dopo le 16:00 (16:08 per 18,27 min,
16:17 per 7,58 min, 18:42 per 1,00 min) = **26,85 minuti non spiegati dal pavimento**. Vanno guardati
al primo giro vivo; non c'è evidenza sufficiente oggi per attribuirli.

### ③ La copertura continua **è stata chiamata, e per progetto non può ripiazzare**

`riconciliaCopertura` gira a ogni ciclo di agent41 (riga 2607), **prima** di `decidiTrigger` e della
selezione. Il suo commento è esplicito (riga 1283):

> «⚠ **NON PIAZZA.** Il ripiazzamento delle gambe mancanti resta al percorso che già piazza — il piano
> e `piazzaCoppia` — e qui ci si limita a **CHIEDERLO** forzando il mini-ciclo.»

Quindi: **è stata chiamata, ha deciso correttamente, e ha dichiarato**. Chi doveva agire è il
mini-ciclo, e il mini-ciclo su 82 esecuzioni ha risposto **49 volte `nessuna-azione`** e 33
`allocato`.

**⚠ E c'è un buco di strumentazione da dichiarare**: `riconciliaCopertura` scrive con `annuncia`,
cioè nei log di pm2, **non nel giornale**. Nel giornale del 16 agosto ci sono **zero** record di
copertura. Non si può quindi dire *quali* mercati abbia dichiarato scoperti né *quando* — solo che è
stata chiamata. È la stessa lacuna di §5.2 p.10: «non è che nessuno l'abbia guardato, è che nessuno
lo scrive».

### ④ L'unico percorso che ripiazza davvero è stato **saturato dal tetto**

`rimpiazzo-gamba` (`source: auto-close-on-fill`) è l'unico che rimette una gamba sul libro dopo un
fill. Nelle sue 157 tracce del 16 agosto:

| n | esito | lettura |
|---|---|---|
| **133** | `saltato-tetto-saturo` | «il tetto del mercato ($56) è già occupato da posizione ($30.83) e ordini a riposo ($63.95): il rimpiazzo **aspetta** che la chiusura liberi spazio, non forza il tetto» |
| 21 | `saltato-sotto-size-minima` | «$0.613 comprano 1.3 share, sotto il minimo premiante del venue (50)» |
| **3** | `rimpiazzata` | «la gamba NO era stata eseguita: torna sul libro a 0.14 per 152.4 share» |

**132 dei 133 saltati sono su `33ec826f37…`**, che è anche il mercato con la copertura migliore
(66 %): il tetto ha morso lì perché lì c'era la posizione. Il comportamento è **corretto** — non
forzare il tetto è la regola — ma il risultato è che **la via di ritorno esisteva e per 133 volte su
157 non poteva percorrerla**.

*(Nota utile e già segnata come aperta in `APERTI.md` punto 3: il percorso che rigenera il BUY sulla
gamba posseduta è proprio questo, `op: 'rimpiazzo-gamba'` / `source: 'auto-close-on-fill'`.)*

---

## 4 · IL TEMPO IN COPERTURA PIENA

**Totale: 14,70 h su due gambe contro 7,15 h su una gamba sola** (più 7,54 h a zero gambe dentro la
finestra dei mercati). **50,0 % della somma delle finestre.**

Per mercato: da **94,7 %** (`c9abc0f43d…`, un'ora sola di vita e quasi perfetta) a **23,8 %**
(`f2b0c93903…`, il mercato che ha assorbito 267 dei 308 blocchi del pavimento di profondità). Il
mercato con più capitale, `de0b0b24bf…` (FL-27), sta al **54,3 %** e da solo produce **169,4 minuti**
di gamba singola, cioè il 58 % del totale.

### 4-bis · Riscontro aggregato sul venue

Dai 75.077 `listOpenOrders` del 16 agosto (marketId redatto, quindi solo aggregato):

| ordini vivi al venue | campioni | quota |
|---|---|---|
| 0 | 45.767 | 61,0 % |
| 1 | 8.354 | 11,1 % |
| 2 | 18.567 | 24,7 % |
| 3 | 1.210 | 1,6 % |
| ≥ 4 | 1.179 | 1,6 % |

**Il riscontro conferma la ricostruzione senza contraddirla.** Il 61 % di campioni a zero riguarda
per la gran parte mercati *senza* ordini (la scansione interroga tutta la lista, non solo i tre
attivi), quindi non è confrontabile riga per riga con il 25,7 % di «zero gambe» calcolato dentro le
finestre. Ciò che conta è il **rapporto fra 1 e 2**: al venue ci sono 8.354 campioni a una gamba
contro 18.567 a due, cioè **31,0 % di tempo a gamba singola** quando c'era almeno un ordine — contro
il **32,7 %** che la ricostruzione calcola (7,15 su 21,85 h con ordini). **Due fonti indipendenti,
due punti percentuali di distanza.**

---

## 5 · DOVE SI SISTEMA — in ordine di minuti causati ieri

| # | punto | minuti | stato |
|---|---|---|---|
| **1** | **`nozionale-mercato-oltre-tetto` va nei precontrolli di `replaceManualOrder`**, e deve **sottrarre l'ordine che sta sostituendo** dal nozionale a riposo | **160,8** | 🔴 **APERTO** — il gate è stato aggiunto ieri sera e ha creato questo |
| **2** | **il pavimento di profondità bloccava i rinnovi** | **65,0** | 🟢 **CHIUSO ieri alle 15:55** (`63c10a0`, `esenzione-rinnovo.js`) e **in servizio** dal riavvio di agent40. ⚠ Restano **26,85 min** di `expired` dopo le 16:00 non spiegati: da guardare al primo giro |
| **3** | **`doppione-identico` va nei precontrolli di `replaceManualOrder`** | **36,2** | 🔴 **APERTO** — stesso difetto del punto 1, stesso commit di ieri sera |
| **4** | **`auto-close-on-fill` cancella una gamba e non la rimette** (episodio 16:40:09, tornata solo dopo 18 min) | **18,0** | 🟡 **PARZIALE** — il percorso `rimpiazzo-gamba` esiste, ma vedi punto 5 |
| **5** | **la via di ritorno è saturata dal tetto per mercato**: 133 `saltato-tetto-saturo` su 157 | *indiretto* | 🟡 **APERTO per decisione** — il comportamento è corretto; è il **tetto a $56/$61,25 contro una posizione già a $30,83** a non lasciare spazio. È una scelta di rischio dell'operatore, non un difetto |
| **6** | **la copertura continua dichiara e non scrive nel giornale** | *non misurabile* | 🔴 **APERTO** — `riconciliaCopertura` usa `annuncia` (log pm2), zero record nel giornale. Senza quelli non si può dire *quali* gambe abbia visto mancanti |
| **7** | **la copertura continua non ripiazza** (`APERTI.md` punto 1) | *è la causa del §3③* | 🔴 **APERTO** — ed è il lavoro che l'operatore ha già messo in coda. ⚠ **Va fatto senza rimettere `controlloCapitaleFermo`**: le 799 ricostruzioni del 16 agosto sono venute da lì |
| 8 | `cancelled-externally` (1 episodio, 2,0 min) | 2,0 | ⚪ nessuna azione: cancellazione fatta fuori dal pannello |
| 9 | `mid-stantio` come causa di morte | 0,0 | 🟢 **CHIUSO** — 20 s → 120 s ieri sera, non morde più |

### La correzione dei punti 1 e 3 è una sola, ed è piccola

Entrambi i gate vanno **spostati o duplicati** nei precontrolli di `replaceManualOrder`, dove già
vivono il tetto per ordine e la chiave di idempotenza. Le due condizioni da rispettare, e sono
quelle che il difetto insegna:

* **la stessa funzione, non una copia** — precontrollare con un numero diverso da quello che poi
  rifiuta è peggio che non precontrollare (è scritto nel commento del precontrollo esistente, riga
  1782, ed è il reperto **D1**);
* **il nozionale a riposo deve escludere l'ordine che si sta sostituendo**, o il tetto conta due
  volte lo stesso capitale e rifiuta un riprezzo che **non aggiunge un dollaro**.

**Costo stimato del non farlo: 197 minuti su 21,85 ore con ordini, cioè il 15 % del tempo di
mercato.** E sono minuti in cui il bot era **direzionale** invece che neutrale — il rischio che tutta
l'architettura della coppia esiste per non correre.

---

## Appendice · come rifare questa misura

```bash
node scripts/ricerca/cronologia-gambe-16-agosto.js          # il 16 agosto
GIORNO=2026-08-17 node scripts/ricerca/cronologia-gambe-16-agosto.js   # un altro giorno
```

Sola lettura, scrive solo in `data/ricerca/`. Nessuno stato del bot viene toccato.

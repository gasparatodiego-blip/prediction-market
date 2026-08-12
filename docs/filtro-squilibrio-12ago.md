# Filtro sullo squilibrio delle due gambe — misura prima della decisione

**12 agosto 2026, ~20:15 UTC.** Sola lettura: nessun codice operativo toccato, nessun ordine, nessun
riavvio. Riproducibile con `node scripts/misura-filtro-squilibrio.js` e
`node scripts/misura-volatilita-per-fascia.js`.

---

## Il fatto che ha aperto la domanda

Il 12 agosto alle 17:51 il bot ha aperto **Vindman** (`0xb73f32c2`) a mid **0,8675** — gambe a 86,7¢ e
12,4¢. Alle 17:58:0x la gamba NO è stata riempita per intero (24 share, $2,976), la gamba opposta è
stata cancellata correttamente, e la posizione è rimasta scoperta con una perdita latente di **$0,91**.

La «finestra di mid `[0,36 · 0,64]`» che agent41 stampa all'avvio **non è mai stata un cancello**:
`concentration.finestraMid` ha due consumatori — quella riga di log e il proprio selfcheck — e nessun
percorso di piazzamento la consulta. L'unico cancello reale è il **tetto per ordine** ($21,34), che
guarda i dollari e non lo squilibrio, e che **si allarga quando il tetto per mercato scende**: la
finestra che ne deriva è `p ≤ costoCoppia · tettoOrdine / capitaleAllocato`, e con i $24 che la griglia
ha davvero allocato vale **`[0,129 · 0,871]`**.

---

## 1 · L'effetto delle tre soglie

Imbuto reale: **pavimento premiante ≤ tetto** → **orizzonte ≥ 18 h** → [soglia sul mid].
Capacità = mercati ammissibili × $32,67. Capitale $663,11; obiettivo del 90% = $596,80.

### Board vivo (19:57 UTC)

| scenario | mercati | capacità | % del capitale |
|---|---|---|---|
| senza filtro | 23 | $751 | 113% |
| `[0,25 · 0,75]` | 21 (−2) | $686 | 103% |
| `[0,30 · 0,70]` | 19 (−4) | $621 | **94% — sotto il capitale** |
| `[0,35 · 0,65]` | 18 (−5) | $588 | **89% — sotto il capitale e sotto l'obiettivo** |

### Su tutti i 31 snapshot della giornata

**Mercati ammissibili**

| scenario | min | Q1 | mediana | Q3 | max | snapshot che coprono il 90% |
|---|---|---|---|---|---|---|
| senza filtro | 7 | 24 | **29** | 42 | 91 | **28/31** |
| `[0,25 · 0,75]` | 5 | 22 | **28** | 40 | 90 | 27/31 |
| `[0,30 · 0,70]` | 5 | 22 | **27** | 39 | 86 | 27/31 |
| `[0,35 · 0,65]` | 5 | 21 | **25** | 35 | 75 | **25/31** |

**Capacità in dollari**

| scenario | min | Q1 | mediana | Q3 | max | snapshot **sotto** il capitale ($663) |
|---|---|---|---|---|---|---|
| senza filtro | $229 | $784 | **$947** | $1.372 | $2.973 | **3/31** |
| `[0,25 · 0,75]` | $163 | $719 | **$915** | $1.307 | $2.940 | 6/31 |
| `[0,30 · 0,70]` | $163 | $719 | **$882** | $1.274 | $2.810 | 6/31 |
| `[0,35 · 0,65]` | $163 | $686 | **$817** | $1.143 | $2.450 | **7/31** |

### Le due letture

**Alla mediana il filtro costa poco.** Anche la soglia più stretta lascia $817, cioè il **123%** del
capitale: nessuna delle tre rende il 90% strutturalmente irraggiungibile in una giornata tipica.

**Nelle finestre magre costa moltissimo, ed è lì che conta.** Sullo snapshot delle **17:34** — quello da
cui è nato il piano da 6 mercati — l'effetto è:

| | senza filtro | `[0,25]` | `[0,30]` | `[0,35]` |
|---|---|---|---|---|
| 17:34 | 14 · $457 · 69% | 9 · $294 · 44% | **6 · $196 · 30%** | **6 · $196 · 30%** |
| 06:00 | 7 · $229 · 34% | 5 · $163 · 25% | 5 · $163 · 25% | 5 · $163 · 25% |
| 03:31 | 27 · $882 · 133% | 18 · $588 · 89% | 17 · $555 · 84% | 16 · $523 · 79% |

**Risposta diretta alla domanda «quale soglia fa scendere la capacità sotto il capitale»:** tutte e tre
lo fanno in qualche snapshot, ma con frequenze diverse — **3/31 senza filtro, 6/31 a 0,25 e 0,30,
7/31 a 0,35**. Sul board di adesso (19:57) **`[0,30]` e `[0,35]` sono già sotto**, `[0,25]` no.
La soglia `[0,35 · 0,65]` raddoppia i giri in cui il capitale non ha dove andare, e toglie **tre**
snapshot alla copertura del 90%.

---

## 2 · Quanto sarebbe servito davvero

Oggi il bot ha aperto **tre** mercati (6 gambe, tutte alle 17:51). Il piano ne conteneva 6, ma tre
avevano regole di venue illeggibili e non sono mai stati eseguibili.

| mercato | mid | `[0,25]` | `[0,30]` | `[0,35]` | esito reale |
|---|---|---|---|---|---|
| Ben Butler FL-09 `0xf2b0c939` | 0,520 | passa | passa | passa | entrambe le gambe vive fino al KILL |
| Chalifoux FL-09 `0xe368e5e6` | **0,285** | passa | **BLOCCATO** | **BLOCCATO** | entrambe le gambe vive fino al KILL — **nessun problema** |
| **Vindman** `0xb73f32c2` | **0,8675** | **BLOCCATO** | **BLOCCATO** | **BLOCCATO** | **gamba NO fillata ⇒ scoperta, −$0,91** |
| *(non eseguibili)* `0xa875e0b4` | 0,213 | bloccato | bloccato | bloccato | mai partito (regole illeggibili) |
| *(non eseguibili)* `0xf43d99c0` | 0,435 | passa | passa | passa | mai partito |
| *(non eseguibili)* `0xc16fade4` | 0,4005 | passa | passa | passa | mai partito |

**Vindman sarebbe stato escluso da tutte e tre le soglie.** È il caso che il filtro coglie.

**Ma `[0,30]` e `[0,35]` avrebbero bloccato anche Chalifoux, che ha funzionato senza un problema:**
entrambe le gambe vive dalle 17:51 fino al KILL delle 18:23, zero fill, zero scoperto. In termini di
episodi osservati oggi il conto è **1 danno evitato contro 1 mercato sano tagliato** per le due soglie
strette, e **1 contro 0** per `[0,25 · 0,75]`.

**Fill di oggi: uno solo**, la gamba NO di Vindman. Il ledger `data/safety-fills.jsonl` porta 9 righe
oggi, tutte `nofill`: la riga di `fill` per quella gamba **non c'è**, ed è l'anomalia di riconciliazione
già registrata — la posizione esiste al venue e il ledger non la conosce.

---

## 3 · L'ipotesi sul rischio, misurata

Fonte: `data/mid-history-2026-08-12.jsonl` (agent34, un campione per mercato ogni ~75 s).
**434 mercati** con almeno 10 campioni; 37 scartati per serie troppo corta.

⚠ **La mediana di |Δ| fra campioni consecutivi è ZERO in ogni fascia**, e non è un difetto dei dati: fra
due campioni a 75 s la maggior parte dei mercati non si muove affatto. Le statistiche qui sotto sono
quelle che sopravvivono a quella massa a zero.

| fascia di mid | mercati | \|Δ\| medio ¢ | \|Δ\| p90 ¢ | passi oltre 2,25¢ | escursione ¢ | relativo % |
|---|---|---|---|---|---|---|
| 0,02–0,10 | 31 | 0,207 | 0,50 | **0,00%** | 3,80 | 4,38 |
| 0,10–0,25 | 45 | 0,189 | 0,10 | 1,20% | 6,15 | 1,27 |
| **0,25–0,35** | 75 | **0,628** | 1,00 | **5,56%** | **21,00** | 2,36 |
| **0,35–0,65** *(centro)* | 187 | 0,207 | 0,50 | 1,37% | 18,50 | 0,51 |
| **0,65–0,75** | 24 | **0,528** | 0,50 | **4,50%** | **28,75** | 2,32 |
| 0,75–0,90 | 15 | 0,299 | 0,05 | 1,95% | 24,50 | 1,72 |
| 0,90–0,98 | 23 | 0,453 | 0,85 | 2,86% | 9,50 | 6,34 |

**Il confronto che decide:**

| | mercati | \|Δ\| medio | p90 | passi oltre mezza banda | escursione | relativo |
|---|---|---|---|---|---|---|
| **CENTRO** `[0,35 · 0,65]` | 189 | 0,212¢ | 0,50¢ | **1,50%** | **19,00¢** | 0,54% |
| **ESTREMI** `<0,25` o `>0,75` | 147 | 0,189¢ | 0,05¢ | **0,22%** | **5,00¢** | 2,03% |
| **rapporto estremi/centro** | | **0,89×** | **0,10×** | **0,15×** | **0,26×** | 3,76× |

### L'ipotesi è smentita sulla misura che conta

Il rischio che il filtro dovrebbe coprire è che il mid **esca dalla banda premiante**, che è **±2,25¢
in assoluto**. Quindi decide la colonna assoluta — e in assoluto **gli estremi si muovono MENO del
centro**: un settimo dei passi oltre mezza banda, un quarto dell'escursione giornaliera.

L'unica colonna che sostiene l'ipotesi è quella **relativa** (3,76×), ed è la misura che per costruzione
esplode vicino ai bordi: un mercato che va da 0,05 a 0,06 si è mosso di **1 centesimo**, che la banda
quasi non registra, ma è **+20%**.

**E la struttura non è nemmeno monotona nella distanza da 0,50.** Le fasce più mosse in assoluto sono le
**spalle** — `0,25–0,35` (0,628¢, 5,56% di salti) e `0,65–0,75` (0,528¢, 4,50%) — cioè **proprio quelle
che le soglie `[0,30]` e `[0,35]` taglierebbero per prime**. Le fasce davvero estreme (`0,02–0,10`,
`0,10–0,25`) sono fra le più calme.

### Vindman era uno dei mercati più CALMI della sua fascia

| | \|Δ\| medio | salto massimo | passi oltre 2,25¢ | escursione |
|---|---|---|---|---|
| Ben Butler (mid 0,52) | 0,005¢ | 0,30¢ | 0,00% | 0,40¢ |
| Chalifoux (mid 0,285) | 0,017¢ | 1,00¢ | 0,00% | 2,00¢ |
| **Vindman (mid 0,8675)** | **0,041¢** | **2,20¢** | **0,00%** | **7,45¢** |
| *mediana della fascia 0,75–0,90* | — | — | *1,95%* | *24,50¢* |

Vindman è **l'11° su 15** della sua fascia per escursione: escursione **7,45¢ contro una mediana di
24,50¢**, e **zero** passi oltre mezza banda in tutta la giornata. Nessuno dei tre mercati aperti oggi
ha avuto un solo passo oltre mezza banda.

**Conclusione onesta: la perdita di $0,91 non è stata prodotta da un mercato volatile.** È stata
prodotta da un singolo movimento di ~4¢ nei due minuti attorno al fill, su un mercato che per tutto il
resto della giornata è stato più fermo della mediana della sua fascia. Un filtro sul mid, giustificato
come «gli estremi si muovono di più», **correggerebbe un episodio, non una regolarità**.

### E il meccanismo strutturale che resta

Il mid **non** peggiora `f_min`: `Q = capitale / costoCoppia` non dipende dal mid, quindi la frazione di
fill sotto cui il residuo non è piazzabile è identica a 0,50 e a 0,87. Lo dice già §5 punto 52.

L'**unico** effetto strutturale del mid è che la gamba cara costa più dollari a parità di share — ed è
**esattamente ciò che il tetto per ordine già misura**. Un filtro sul mid sarebbe quindi una **seconda
espressione dello stesso vincolo**, formulata in probabilità invece che in dollari, con il rischio di
divergere dalla prima. La differenza vera fra i due è che il tetto per ordine si allarga quando la
griglia alloca meno del tetto (da `[0,360 · 0,640]` a `[0,129 · 0,871]`), mentre una soglia sul mid
resterebbe fissa: **se si vuole quel comportamento, la leva onesta è ancorare la finestra al capitale
ALLOCATO invece che al tetto, non aggiungere una costante nuova.**

---

## 4 · Dove andrebbe applicato

### Il punto unico esiste già

`placeManualOrder` è l'imbuto obbligatorio di **ogni** ordine, e non è una promessa:
`lib/maker/percorsi-di-invio.test.js` (**18/18**) asserisce che **nessun** percorso lo aggiri. I gate
sono già numerati e in sequenza: GATE 1 gestione manuale · GATE 2 regole di venue · GATE 2-ter fine
scala · GATE 3 guard condiviso sul prezzo · GATE 3-bis mid vivo · GATE 4 tetto per ordine · GATE 5 kill
· GATE 6 orologio del mercato.

**Il filtro andrebbe come gate accanto al GATE 4**, che è dove vive già il vincolo gemello (il tetto per
ordine). Non serve creare un punto nuovo.

### Ma un gate da solo non basta, ed è la lezione di §5 punto 90

Un cancello al piazzamento rifiuta **una gamba alla volta** dopo che il piano ha già assegnato il
capitale. È esattamente il difetto che `verdettoQuotabilita` ha corretto: la quotabilità è diventata un
**filtro a monte** (`lib/rewards/quotabilita.js`) che chiama `planBehindBest`, **la stessa funzione** del
piazzamento. Lo stesso schema va riusato:

- **a monte**, nell'allocatore, perché il capitale venga ridistribuito invece che rifiutato;
- **al piazzamento**, come gate, perché sia una garanzia e non una speranza;
- **una funzione sola**, importata da entrambi — mai due costanti.

### I quattro percorsi che lo devono attraversare

| percorso | come arriva | coperto dall'imbuto? |
|---|---|---|
| piano di agent41 | `allocation-reset` → allocazione in blocco → corsia manuale | **sì** |
| corsia manuale (pannello) | direttamente | **sì** |
| riprezzo di agent40 | `replaceManualOrder` → corsia manuale | **sì** |
| mm-tracking | corsia manuale | **sì** |

Tutti e quattro passano dallo stesso imbuto: **un gate lì li copre tutti**, senza toccarne nessuno.

### La chiusura deve restare sempre permessa — e il marcatore esiste già

Se un mercato aperto si sbilancia dopo, chiudere deve restare possibile: altrimenti si resta **bloccati
dentro**, che è il guasto peggiore di quello che il filtro previene.

Il marcatore c'è già ed è provato: **`chiudePosizione: true`**, introdotto per l'esenzione dal tetto per
ordine (`lib/maker/esenzione-chiusura.js`). Misurato: lo dichiarano **6 punti in `auto-close.js`** (L1 e
sorella, incremento sorella, chiusura rapida, i due rami della chiusura pre-scadenza, uscita forzata) e
**zero** percorsi di liquidità — `plan-to-orders`, `bulk-allocate`, `auto-reprice`, `mm-tracking` non lo
nominano affatto.

Quindi la regola di esenzione è una riga sola e riusa un marcatore già verificato:

> il filtro sullo squilibrio **non si applica** quando `spec.chiudePosizione === true`.

⚠ Con una differenza rispetto al tetto per ordine: lì l'esenzione è una **prova** rifatta sullo snapshot
del venue (`provaChiusura`), perché esentare dal tetto lascia passare più dollari. Qui l'esenzione non
allarga nessun limite di spesa — permette solo di **appaiare** una posizione che esiste già — quindi la
sola dichiarazione basta. È una scelta da mettere per iscritto, non da dare per ovvia.

---

## Sintesi per la decisione

1. **Il costo alla mediana è modesto** (−1 / −2 / −4 mercati), **ma nelle finestre magre è decisivo**:
   alle 17:34 `[0,30]` e `[0,35]` avrebbero lasciato 6 mercati e $196, cioè il 30% del capitale.
2. **Vindman sarebbe stato bloccato da tutte e tre.** `[0,30]` e `[0,35]` avrebbero bloccato anche
   Chalifoux, che non ha dato alcun problema.
3. **L'ipotesi «gli estremi si muovono di più» è smentita** sulla misura che conta: in assoluto si
   muovono **0,15×** del centro per salti oltre mezza banda. Le fasce più mosse sono le **spalle**, che
   le soglie strette taglierebbero per prime. Vindman era l'11° su 15 della sua fascia per calma.
4. **Se si vuole comunque un limite**, `[0,25 · 0,75]` è l'unica delle tre che coglie Vindman senza
   tagliare nulla di ciò che oggi ha funzionato, e senza portare il board vivo sotto il capitale.
5. **L'alternativa più coerente col resto del sistema** non è una soglia nuova: è ancorare la finestra
   del tetto per ordine al capitale **allocato** invece che al tetto — così il vincolo che già esiste
   smette di allargarsi proprio quando la griglia alloca meno.

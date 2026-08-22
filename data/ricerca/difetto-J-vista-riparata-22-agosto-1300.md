# DIFETTO J — la vista di agent24 riparata, e cosa appare sotto le 48 ore

**22 agosto 2026, 13:00Z.** Prima la riparazione della vista, poi la misura. Nessun ordine toccato,
nessuna manopola spostata: la sola modifica è il **censimento** di agent24.

---

## 1 · IL TRONCAMENTO — dove, con quale criterio, e quanto costerebbe leggerlo tutto

**Dove.** `agents/agent24-liquidity-rewards.js:149` — `FAST_MAX_PAGES`, difetto **120** pagine, env
`REWARD_FAST_MAX_PAGES`. È il budget dell'**intera** passata 2, non della singola fetta; il ciclo delle
fette lo controlla in cima a ogni iterazione (`if (pagineUsate >= FAST_MAX_PAGES) { budgetFinito = true; break; }`).

**Con quale criterio era stato fissato.** Il commento sopra la costante lo dichiara: *«120 pagine coprono
le 48 ore misurate (135 pagine per 8 fette, di cui le prime sei ne chiedono 98)»* — una misura dell'**8
agosto 2026**, quando le prime sei fette costavano 98 pagine. Oggi ne costano **121**: 21+21+21+16+21+21.
Il budget viene superato **dentro** la sesta fetta, il `break` scatta a `i = 6`, e le fette **+36-42 h** e
**+42-48 h** non vengono interrogate affatto. Non è un caso limite: succede a **ogni giro**.

**Quante pagine ne leggeva:** `120` (le prime 6 fette su 8).
**Quante ne servirebbero per la stessa paginazione:** `156` (censimento delle 08:00, 8 fette da 6 h).
**Quante ne servono per una copertura VERA:** vedi sotto — **839**, e non basta.

**Il budget esiste per `MAX_RPS`? Sì, ed è la ragione giusta.** La coda `httpGet` di agent24 è
**serializzata** a `MAX_RPS = 1.5` (`agent24:64`), cioè 667 ms per richiesta a prescindere dalla latenza.
Il costo di lettura si converte direttamente in secondi:

| via | pagine | secondi a `MAX_RPS = 1.5` | picco RSS | copertura |
|---|---|---|---|---|
| oggi (budget 120) | 120 | 80 s | — | **6 fette su 8** |
| stessa paginazione, 8 fette | 156 | 104 s | — | 8 fette, ma **6 troncate a 2.100** |
| **bisezione adattiva** fino a 45 min di ampiezza | **839** | **559 s (9,3 min)** | **395 MB** | **2 fette ancora troncate** |
| **la riparazione** (`/sampling-markets` + Gamma per id) | **30 richieste** | **20 s** | — | **completa** |

> ⚠ **IL BUDGET ERA IL SINTOMO, NON LA CAUSA.** Gamma tronca **ogni** query a 2.100 record — misurato
> oggi: `offset ≥ 2100` risponde **HTTP 422**, non una pagina vuota. Una fetta da 6 h contiene più di
> 2.100 mercati (sei fette su otto rispondono **esattamente 2.100**), quindi **anche una fetta letta per
> intero è troncata**, e i premiati stanno oltre il taglio. Verificato per costruzione: sulla fetta
> 0-6 h le 21 pagine complete contengono **zero** mercati premianti.
> Alzare `FAST_MAX_PAGES` a 156 avrebbe letto due fette in più e lasciato sei fette cieche.
> **Anche il censimento «senza troncamenti» delle 08:00 era troncato**: dichiarava `troncata:false`
> perché lo script usciva su risposta vuota, ma sei fette su otto si erano fermate a 2.100 esatti.

**E il collo non sono i libri.** Confermato: `POST /books` legge 3.112 libri in 2,4 s; la lettura dei
1.702 libri di questa misura è istantanea rispetto alle 156 richieste `GET` seriali di Gamma.

---

## 2 · LA RIPARAZIONE — si cambia la DOMANDA, non il numero

`agents/agent24-liquidity-rewards.js`, **passata 3** (righe 155-190 per le costanti, 413-471 per il corpo).

**L'idea in una riga:** l'elenco dei mercati premiati non si **deduce** enumerando l'universo, si
**chiede a chi lo pubblica**. Il CLOB espone `GET /sampling-markets` — la lista dei mercati inclusi nel
campionamento dei reward — a pagine da 1.000 con cursore.

1. **(a) L'elenco.** 17 richieste, 2,8 s, **16.343 mercati**. Si filtra alla finestra `FAST_WINDOW_DAYS`
   (48 h) sul `end_date_iso` **pubblicato dal venue**.
2. **(b) Le righe.** I `condition_ids` che Gamma non ha già dato si chiedono a Gamma **in blocco**
   (50 per query, misurato: 100 rispondono con URL da 8.099 caratteri; 50 tiene l'URL a 4,1 k) e si
   passano alla **stessa `raccogli()`** delle altre due passate.

**Perché è la riparazione giusta e non un numero alzato:**

- **Nessun campo inventato.** La riga della passata 3 è costruita da Gamma dalla stessa funzione delle
  altre due: è **indistinguibile** da una riga della passata 1. Nessun ramo nuovo a valle, nessun ripiego.
- **Monotona.** Può solo **aggiungere**. Nessun filtro, nessuna soglia, nessun cancello, nessun criterio
  di ordinamento toccato. Un mercato già trovato da Gamma resta quello di Gamma (che porta lo slug
  dell'evento e il volume 24 h, che il campionamento non pubblica). *Provato dal blocco ⑤ del test.*
- **Fail-open nei due versi.** CLOB giù ⇒ restano passate 1 e 2. Gamma-a-finestre giù ⇒ resta la passata
  3. Dichiarato nel log, non dedotto. *Provato dal blocco ④.*
- **Non si inventa una scadenza.** Un premiato senza `end_date_iso` **non** viene collocato nella
  finestra: «non ho letto la data» non è «la data è vicina» — è la famiglia `Number(null) === 0` di §5.3,
  e qui il ramo sbagliato **aprirebbe** un cancello. Sono **1.343** oggi, e vengono contati nel log.
  *Provato dal blocco ⑥.*

### La misura della riparazione, contro il venue vero

```
scoperta: 21p listino (+622) · 120p in 6/8 fette da 6h (+8 nuovi entro 2g) · 5 fetta/e al tetto
  dei 2.100: copertura PARZIALE · budget fette esaurito a 120p oltre +36h (coperto dalla passata 3)
  → 1243 mercati premiati
scoperta/venue: 17p sampling · 16343 mercati premiati pubblicati dal CLOB · 649 entro 2g
  · 643 non visti da Gamma → 13 query per id (+613 nuovi) · 1343 senza scadenza pubblicata:
  NON collocati nella finestra
```

| | prima | dopo |
|---|---|---|
| mercati premianti nel censimento | 633 | **1.243** |
| entro 48 h | 11 *(referto 06:45)* / 92 *(censimento 08:00, esso stesso troncato)* | **551** |
| durata di `fetchRewardMarkets` | ~94 s | **118,7 s** (+24 s) |
| **picco RSS** | — | **117,5 MB** *(fermo dichiarato: 700 MB)* |

**30 richieste in più, 24 secondi, 117 MB di picco.** Il fermo di memoria non è stato avvicinato.

---

## 3 · LA MISURA — cosa esiste davvero sotto le 48 ore

Sorgente: `data/ricerca/vista-completa-1300.json` (censimento vero + 1.702 libri letti in blocco).
Size per mercato **$56,08**, distanza **0,456 · v**.

| | n | montepremi |
|---|---|---|
| **sotto 24 h** | **249** | **$6.657/giorno** |
| **fra 24 e 48 h** | **302** | **$5.816/giorno** |
| entro 48 h, totale | **551** | $12.473/giorno |

### Chi passa i nostri cancelli

| cancello | scarta |
|---|---|
| `scadenza-sotto-24h` (§4.13) | 249 — **tutti** i sotto-24 h |
| `famiglia-meteo` | 438 (di cui 239 già esclusi dalle 24 h) |
| `minsize-oltre-50` / `pavimento-oltre-tetto` | 10 |
| **PASSANO TUTTI I CANCELLI** | **101**, montepremi **$1.716/giorno** |

Dei 101: **91 col libro letto**, 10 senza tocco.
⚠ **64 dei 91 hanno concorrenza in banda ZERO su libro letto, e NON vanno contati**: è lo `0` che
`allocator.js:1133` rifiuta di credere (`profondita: non-verificata`, §5.2 p.55). Li dichiaro ed escludo.
**Restano 27 mercati con concorrenza MISURATA > 0**, premio modellato **$146,91/giorno** in totale.

### Concorrenza in banda e QUOTA DI LIBRO (i 27 misurabili)

Concorrenza `competitorQ`: mediana **68,6**, minimo 1,6, massimo 254,4.

| quota di libro entrando alla nostra size | n |
|---|---|
| < 25 % | 17 |
| **25-50 %** ⚠ | **2** |
| **≥ 50 %** ⚠⚠ | **8** |

**I dieci marcati:**

| quota | premio/g | montepremi/g | ore | `competitorQ` | mercato |
|---|---|---|---|---|---|
| **91,7 %** | $45,84 | $50 | 35,4 | 1,57 | Will "Spain" be in the headlines this week? |
| **85,0 %** | $8,50 | $10 | 35,4 | 3,06 | Will "Hot" or "Heat" be in the headlines this week |
| **77,8 %** | $7,78 | $10 | 35,4 | 4,94 | Will Elon post "Deport"… on X this week? |
| **77,6 %** | $7,76 | $10 | 35,4 | 5,01 | Will Elon post "Bitcoin," "Crypto,"… this week? |
| **75,9 %** | $2,28 | $3 | 39,4 | 5,56 | Will Donald Trump publicly insult someone… |
| **69,9 %** | $0,70 | $1 | 35,4 | 7,44 | Will there be exactly 3 earthquakes of magnitude 6… |
| **68,5 %** | $6,85 | $10 | 35,4 | 7,98 | Will Elon post "Border" on X this week? |
| **53,4 %** | $6,41 | $12 | 35,4 | 15,11 | Will MrBeast's next video get between 15 and 20 mi… |
| **41,1 %** | $0,82 | $2 | 35,4 | 25,03 | Will Aq Jol win the second most seats… |
| **32,2 %** | $0,97 | $3 | 35,4 | 36,42 | Iran successfully targets shipping on August 23 |

⚠ **Una quota alta è la stessa cosa vista da due lati**: è la ragione per cui il premio è alto, ed è la
ragione per cui il fill sarebbe **nostro**. La misura del fill non c'è (v. punto 6).

---

## 4 · IL COSTO DEL CANCELLO DELLE 24 ORE — **in servizio, non toccato**

Il cancello scarta **249 mercati** ($6.657/g di montepremi). Ma **quasi tutti sarebbero stati scartati
comunque**: **239 su 249 sono anche `famiglia-meteo`**, 5 anche fuori scaglione.

> **Il costo ESCLUSIVO del cancello delle 24 ore — mercati che perde e che nessun altro cancello
> avrebbe perso — è di CINQUE mercati, $107/giorno di montepremi.**

| ore | montepremi | quota | premio modellato | mercato |
|---|---|---|---|---|
| 23,43 | $55/g | 73,7 % | **$40,54/g** | Will "Mutiny" Opening Weekend Box Office be less than 8m? |
| 23,43 | $45/g | *banda vuota* | *($45/g nominali, non credibili)* | Will "Mutiny" … between 8m and 9m? |
| 15,42 | $1/g | 7,9 % | $0,08/g | Will Donald Trump publicly insult someone on August 22 |
| 11,42 | $3/g | *banda vuota* | *($3/g nominali)* | Will Houthis successfully target shipping on August 22 |
| 11,42 | $3/g | *banda vuota* | *($3/g nominali)* | Iran successfully targets shipping on August 22 |

**Premio modellato perso, contando solo i misurabili: $40,62/giorno**, e **$40,54 di quei $40,62 stanno
in un mercato solo** che scade fra 23,4 ore — cioè a **36 minuti** dal cancello. Gli altri due
misurabili valgono $0,08/g complessivi.

⚠ **Il conto è onesto in una direzione sola**: i tre a banda vuota non si contano (per la regola di
§5.2 p.55), quindi $40,62 è un **limite inferiore**. E il costo è calcolato **ora**: sono cinque mercati
di un'istantanea, non una media.

---

## 5 · IL CONFRONTO ONESTO — il vantaggio dei corti **cresce**, e di molto

Il referto delle 08:00 misurava, sulla vista troncata, **$2,66/g** per il miglior corto contro **$2,53/g**
per il miglior lungo: il **5 %**. Rifatto sulla vista completa, con gli stessi libri e la stessa formula:

| | corti (< 48 h, passano i cancelli, conc. misurata) | lunghi (> 48 h, top 300 per montepremi) |
|---|---|---|
| n misurabili | 27 | 211 |
| **miglior premio/g** | **$45,84** | **$5,80** |
| **mediana premio/g** | **$2,18** | **$0,097** |
| mediana montepremi | $10/g | $3/g |
| mediana `competitorQ` | **68,6** | **755,2** |

**Il vantaggio dei corti REGGE e CRESCE: 7,9× sul migliore, 22× sulla mediana** — non il 5 %.

E **a parità di quota di libro**, che è il confronto che il referto delle 08:00 chiedeva:

| quota di libro | n corti | mediana $/g corti | n lunghi | mediana $/g lunghi |
|---|---|---|---|---|
| 0-10 % | 5 | **$2,18** | 162 | $0,066 |
| 10-25 % | 12 | **$2,01** | 25 | $0,556 |
| 25-50 % | 2 | $0,97 | 9 | $1,03 |
| 50-80 % | 6 | **$6,85** | 5 | $2,98 |
| 80-100 % | 2 | **$45,84** | 2 | $4,26 |

Il vantaggio regge **in quattro fasce su cinque**; nella fascia 25-50 % i due si equivalgono (su 2 e 9
mercati: campione troppo piccolo per dire altro).

**Da dove viene.** Non dal montepremi (3,3× di mediana), ma dalla **concorrenza**: `competitorQ` mediana
**68,6 sui corti contro 755,2 sui lunghi, cioè 11 volte meno**. Sui corti il denominatore della quota è
quasi vuoto — che è esattamente la ragione per cui il referto precedente, con la vista troncata, non
poteva vederlo: **i corti che vedeva erano gli 11 che erano riusciti a passare il taglio**, non i corti.

⚠ **Perché il 5 % di stamattina non era sbagliato, era CIECO**: confrontava il migliore di 11 corti
sopravvissuti al troncamento con il migliore dei lunghi. Con 551 corti veri, il migliore è un altro.

---

## 6 · LA DISTANZA PER FASCIA — **SOLO SIMULAZIONE, non applicata**

Ipotesi: sui corti stare **più lontani** dal mid. Simulata sui **27 corti con concorrenza misurata**
(gli altri 64 hanno quota 1 per costruzione: simularli non misurerebbe niente).

**La griglia dei tick, prima di tutto.** Letta dal venue (`minimum_tick_size` di `/sampling-markets`):
**82 mercati su 91 hanno tick 1,0 ¢**, 9 hanno tick 0,1 ¢. La banda è **`maxSpread` = v**: 87 su 91 a
**4,5 ¢**, 4 a 5,5 ¢. Quindi:

> ⚠⚠ **4,5 ¢ NON È UNA DISTANZA VALIDA SU QUESTI MERCATI**: coincide con il raggio della banda, dove
> `scoreOrder` vale **zero** per costruzione. Sulla griglia da 1 ¢ atterra a **5 ¢**, cioè **fuori
> banda**. Solo 4 mercati su 27 (quelli a banda 5,5 ¢) restano dentro.
> ⚠ E **3,5 ¢ non esiste su griglia 1 ¢**: atterra a 3 o 4 ¢ — 23 casi su 27.

| distanza chiesta | dentro banda | premio totale/g (27 mercati) | quota mediana |
|---|---|---|---|
| **0,456 · v = 2,05 ¢** *(manopola attuale)* | 27/27 | **$101,57** | 8,8 % |
| **3,5 ¢** | 27/27 | **$31,21** | 1,2 % |
| **4,5 ¢** | **4/27** | **$0,46** | 0 % |

**Prova di robustezza** — il risultato non dipende da come si arrotonda al tick:

| convenzione | 0,456 · v | 3,5 ¢ | 4,5 ¢ |
|---|---|---|---|
| arrotonda **allontanando** dal mid | $101,57/g | $31,21/g | $0,46/g |
| arrotonda **avvicinando** al mid | $150,13/g | $91,91/g | $25,47/g |
| prezzo esatto, senza griglia | $146,91/g | $64,58/g | $1,17/g |

**Monotono in tutte e tre**: allontanarsi **costa premio**, e a 4,5 ¢ lo azzera quasi del tutto.

> ### ⚠ IL FILL NON È STIMABILE, E NON LO INVENTO
> La metà dell'ipotesi che potrebbe giustificare la perdita di premio — **meno probabilità di fill
> durante il movimento** — **non è misurabile con i dati che abbiamo**, e la ragione è strutturale:
> - il **tape** esiste solo per i mercati che agent34 sottoscrive, e **nessuno di questi 27 lo è**;
> - `mid-history` ha lo stesso perimetro (§5.2 p.43: `depthAheadUsd` è `null` sulle finestre già cercate);
> - un libro **istantaneo** dà la profondità davanti — mediana **$96,58** in banda — ma la profondità
>   **non è** una probabilità di fill: dice quanto c'è davanti, non quanto spesso viene mangiato.
>
> **Quindi il netto atteso non si calcola.** Quello che la simulazione dimostra è solo il **lato del
> costo**: allontanarsi a 3,5 ¢ costa il **69 %** del premio, a 4,5 ¢ lo **azzera**. Perché l'ipotesi
> stia in piedi, il risparmio sui fill avversi dovrebbe superare quel 69 %, e **non c'è un numero in
> questo repo che lo dica**. Per averlo servirebbe sottoscrivere questi mercati al feed di agent34 e
> aspettare — cioè la corsia di §5.2 p.55, che è una decisione dell'operatore.

---

## 7 · GLI ORDINI E I PROCESSI

**Riavviato: `agent24-liquidity-rewards`, e nient'altro.** È l'unico processo il cui sorgente è cambiato.

- **`agent40-manual-reprice` NON riavviato**: al suo avvio gli ordini a libro diventerebbero
  **PRE-ESISTENTI** — invisibili al motore, non riprezzati, non rinnovati (§4.6). Con `send` aperto
  sarebbe la condanna del libro alla morte per GTD.
- **`agent41-realloc-scheduler` NON riavviato**: nessuna sua riga è cambiata, e riavviarlo azzererebbe
  lo stato della selezione.
- **agent24 non può toccare capitale**: nessun `require` da `lib/maker/` nel suo albero (verificato),
  nessuna credenziale. Scrive `data/liquidity-rewards.json` e basta.
- **La riparazione non può cancellare un ordine**: cambia solo l'insieme dei mercati **scoperti**; la
  cancellazione passa da agent40/agent41/agent43, nessuno dei quali è stato toccato.

## 8 · L'ASSERZIONE

`lib/rewards/finestra-intera-scoperta.test.js` — **20 asserzioni**, sul **comportamento**, non sul
sorgente. Il finto venue riproduce il taglio vero a 2.100 e mette il mercato buono **oltre** il taglio.

- sul sorgente **NON corretto**: **8 rossi su 14**, fra cui la testa
  *«il mercato a 39,9 h è nel censimento» → NON TROVATO*;
- sul sorgente corretto: **20 verdi, 0 rossi**.

## 9 · ALTRI DIFETTI TROVATI — dichiarati, **NON corretti**

**K** — **la passata 1 è troncata quanto la 2, e da sempre.** `MAX_PAGES = 21` è **esattamente** il
tetto dei 2.100 di Gamma: il listino `active=true&closed=false` non ha MAI potuto vedere oltre i primi
2.100 mercati per `id` crescente. Non è un budget: è il muro. Oggi la passata 3 lo copre **solo dentro
la finestra di 48 h**; fuori, il listino resta cieco su ~14.000 mercati premianti. La cura sarebbe
estendere la passata 3 oltre la finestra, ma cambierebbe la composizione del board di §4.13 e la
selezione — **fuori dal perimetro di questo giro**.

**L** — **il censimento delle 08:00 dichiarava `troncata:false` su fette troncate.**
`data/ricerca/script-0800-corti48.js` esce quando la pagina è corta o a 25 pagine, e marca `troncata`
solo nel secondo caso: sei fette su otto si sono fermate a **2.100 esatti**, cioè al tetto della API, e
sono state registrate come complete. È la ragione per cui il numero «92» era a sua volta 6× troppo basso.
Script di ricerca, non codice di produzione: **non toccato**.

**M** — **il montepremi di CLOB e Gamma può divergere.** Su
`0x70b8f5…` (*claude-opus-5-max*) il CLOB pubblica `rewards_daily_rate: 9`, Gamma `rewardsDailyRate: 8`.
La riparazione usa **Gamma** per il valore (è la fonte che il resto della pipeline già legge) e il CLOB
solo per **quali** mercati chiedere, quindi la divergenza non entra nei numeri — ma esiste, ed è la forma
del reperto **D1** fra due publisher. **Non toccato.**

**⚠ Non ho corretto nessuno di questi tre.**

---

## 10 · IN SERVIZIO — confermato in produzione, due giri

`agent24-liquidity-rewards` riavviato **dal file** alle 12:41:09Z (pid 768749). Due scansioni complete:

```
[12:41:18Z] scoperta: 21p listino (+622) · 120p in 6/8 fette · budget fette esaurito a 120p oltre
            +36h (coperto dalla passata 3) → 1246 mercati premiati
            scoperta/venue: 17p sampling · 16317 pubblicati dal CLOB · 625 entro 2g
            · 619 non visti da Gamma → 13 query per id (+616 nuovi)
[12:57:39Z] → 1232 mercati premiati · (+602 nuovi dalla passata 3)
            profondità: 6.8 min per 300 mercati = 1.36 s/mercato · periodo 15 min
```

**Il costo in tempo NON è peggiorato.** La prima scansione ha misurato 13,3 min di fase profondità, ma
la macchina stava girando la suite e gli script di misura: la seconda, a macchina scarica, dà **6,8 min
/ 1,36 s per mercato**, cioè **meglio** dei 7,9-8,6 min misurati prima della correzione. Totale del giro:
~2,1 min di scoperta + 6,8 min di profondità = **8,9 min su un periodo di 15**.
`esclusi per libro MANCANTE: 0`.

### Cinture e ordini — invariati, letti da `/proc/<pid>/environ`

| processo | pid | vivo dal | stato |
|---|---|---|---|
| `agent24-liquidity-rewards` | **768749** | **12:41:09Z** | **riavviato — l'unico** |
| `agent40-manual-reprice` | 624894 | 21/08 04:27 | **intatto** |
| `agent41-realloc-scheduler` | 737613 | 22/08 04:46 | **intatto** |

```
agent40: MAKER_MODE=live-min · MAKER_ADAPTER_DRYRUN=false · MANUAL_ORDER_PLACEMENT=send
         MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V=0.456 · MAKER_LIVE_MIN_MARKET=(vuoto)
agent41: idem + MAKER_MERCATI_CONTEMPORANEI=10 · REALLOC_SCHEDULER_DRY_RUN=0
```

Nessuna variabile nuova richiesta: `REWARD_SAMPLING_MAX_PAGES` e `REWARD_FAST_MAX_ID_QUERIES` sono
**assenti dall'ambiente**, quindi valgono i difetti di sorgente (40 e 30).
`data/venue-orders.json` continua a essere riscritto da agent40 (età < 2 s) e riporta gli stessi
mercati di prima del riavvio. **Nessun ordine toccato.**

### ⚠ LA CONSEGUENZA CHE VA DETTA: IL BOARD È UN ALTRO

| | prima (12:24Z) | dopo (13:06Z) |
|---|---|---|
| righe di board | 297 | 271 |
| sotto 24 h | **3** | **120** |
| fra 24 e 48 h | **1** | **90** |
| oltre 48 h | 280 | **61** |
| il più corto | 2,4 giorni | **14,9 h** |

Il board passa da **4 righe corte su 297** a **210 su 271**. Non è un effetto collaterale: è ciò che la
riparazione doveva produrre. Ma **cambia l'ingresso di tutto ciò che sta a valle** — la selezione di
§4.13, la classifica per `grossRewardDay`, la corsia dei candidati di agent34. **I cancelli non sono
stati toccati e continuano a mordere**: dei 120 corti sotto 24 h che ora arrivano al board, il cancello
delle 24 ore li scarterà **tutti**.

## 11 · DIFETTO N — dichiarato, NON corretto

**`REWARD_MAX_CLOB_MARKETS = 300` era tarato su una scoperta da 633 mercati, e adesso ne vede 1.232.**
Il taglio passa dal **47 % al 24 %** dei premiati, e la quota riservata a `minSize <= 100`
(`sceltiPerLaScansione`, 150 posti) ora sceglie fra **1.218 compatibili** invece che fra poche decine:
la composizione dei 300 è **un'altra**, decisa dalla classifica per montepremi fra molti più candidati.
Il cronometro di agent24 dice che al ritmo attuale (1,36 s/mercato) nel periodo ci starebbe un tetto di
**~395**, quindi la leva esiste — ma alzarla cambia quali mercati arrivano alla selezione, che è
**esattamente ciò che questo giro non doveva toccare**. È una decisione dell'operatore. **Non corretto.**

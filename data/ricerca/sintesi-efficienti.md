# Gli «efficienti» dentro i 65 — capitale piccolo, trading in pari

Generato 2026-08-15T14:07:15.466Z. Sola lettura, nessuna transazione. Sorgenti: `screening-05 · efficienti-01/02`.

## ⚠ Il gruppo si chiude a 4, e allargare il capitale non lo muove

| filtro applicato da solo, sui 65 | wallet |
|---|---|
| capitale $500–6.000 | 35 |
| capitale $500–15.000 | 42 |
| \|P&L 7g\| ≤ $100 | 37 |
| rewards 14g ≥ $300 | 34 |
| due-lateralità ≥ 40% | 35 |
| **tutti e quattro** | **4** |

Togliendo **un** vincolo alla volta si vede quale morde:

| senza… | wallet |
|---|---|
| il vincolo di capitale (qualunque capitale) | 4 |
| il vincolo di P&L | 13 |
| il vincolo di rewards | 11 |
| il vincolo di due-lateralità | 4 |

**L'allargamento chiesto è inerte**: portare il tetto di capitale da $6.000 a $15.000 aggiunge
**0 wallet**, e toglierlo del tutto ne aggiunge **0**. Il collo è `|P&L 7g| ≤ $100`.

## Il gruppo

| wallet | rewards 14g | mediana/g | capitale | P&L 7g | 2 lati | rewards/capitale |
|---|---|---|---|---|---|---|
| `0x52870486f74fcd2fe707821b9aa8da0f6d8c3a16` | $1626,98 | $65,61 | $4119 | $21 | 75% | 39.5% |
| `0x6d7f75befd422de6225ad7b4e256622a7b4d1d58` | $1353,66 | $102,02 | $995 | $15 | 51% | 136.0% |
| `0x71df28d9c7adf5e158b5f6c579c69ab9058c9aa0` | $982,92 | $25,39 | $653 | $-64 | 83% | 150.5% |
| `0x16a092c7d8a641e94016ed6a785fac4b713a227f` | $384,60 | $33,07 | $563 | $-5 | 43% | 68.3% |

I due wallet indicati dall'operatore **non hanno avuto bisogno dell'inclusione forzata**: `0x6d7f75be…` passa tutti e quattro i filtri da solo · `0x52870486…` passa tutti e quattro i filtri da solo.

Gruppo di sensibilità (stessi filtri, `|P&L| ≤ $250`, capitale ≤ $15.000): **10 wallet**. Serve solo a dare un `n` alle misure a valle.

## ① Distanza dal mid

Ricostruita dai soli fill **maker** (un fill taker misura il costo di attraversare lo spread, non
la posizione di quotazione), contro il campione di `prices-history` immediatamente **precedente**
il fill, scartato oltre 180 s di età.

| gruppo | wallet | fill misurati | mediana | q25 | q75 | q90 | quota maker | dalla parte giusta del mid |
|---|---|---|---|---|---|---|---|---|
| efficienti | 4 | 677 | **2,38¢** | 0,75¢ | 9,50¢ | 19,50¢ | 91% | 90% |
| top 5 per rewards | 5 | 1502 | **1,00¢** | 0,50¢ | 2,00¢ | 3,00¢ | 54% | 97% |
| sensibilità | 6 | 1754 | **1,25¢** | 0,50¢ | 2,00¢ | 3,25¢ | 67% | 96% |

Wallet per wallet (mediana delle proprie distanze):

| wallet | gruppo | ore coperte | fill maker | misurati | mediana | q90 | coincidenza col campione successivo |
|---|---|---|---|---|---|---|---|
| `0x52870486f7…` | efficiente | 584 | 385 | 300 | 0,50¢ | 2,50¢ | 6% |
| `0x6d7f75befd…` | efficiente | 441 | 55 | 54 | 2,25¢ | 24,50¢ | 7% |
| `0x71df28d9c7…` | efficiente | 314 | 730 | 301 | 2,50¢ | 14,50¢ | 0% |
| `0x16a092c7d8…` | efficiente | 366 | 22 | 22 | 13,25¢ | 37,00¢ | 0% |
| `0x41e6de55cf…` | sensibilita | 212 | 2745 | 300 | 0,50¢ | 2,00¢ | 10% |
| `0x3b6930e90b…` | sensibilita | 216 | 251 | 251 | 1,50¢ | 3,00¢ | 2% |
| `0xc37d459c81…` | sensibilita | 249 | 723 | 301 | 1,00¢ | 3,00¢ | 8% |
| `0x7cd6fab8b2…` | sensibilita | 650 | 333 | 300 | 1,00¢ | 3,50¢ | 5% |
| `0x82ae434f98…` | sensibilita | 57 | 3768 | 301 | 2,50¢ | 10,50¢ | 3% |
| `0x2f5242b73c…` | sensibilita | 401 | 640 | 301 | 1,50¢ | 3,85¢ | 6% |
| `0x30fb41b5a0…` | top5 | 35 | 5823 | 301 | 1,00¢ | 3,00¢ | 6% |
| `0x403f2471f8…` | top5 | 187 | 2040 | 301 | 2,00¢ | 5,00¢ | 3% |
| `0x5c0af092b5…` | top5 | 187 | 1122 | 300 | 1,65¢ | 3,50¢ | 3% |
| `0xeed8c2be41…` | top5 | 180 | 2530 | 300 | 0,55¢ | 3,00¢ | 7% |
| `0xf7aa193b1d…` | top5 | 133 | 3157 | 300 | 1,00¢ | 2,50¢ | 12% |

L'ultima colonna è la **prova che la serie non è il prezzo dell'ultimo scambio**: se lo fosse, il
campione successivo al fill coinciderebbe col prezzo del fill quasi sempre.

**La stessa distanza, normalizzata sul raggio della banda premiante** (`maxSpread` del mercato:
una distanza di 2,5¢ vale metà in un mercato a 5¢ di raggio e più della metà in uno a 4,5¢).
⚠ Poggia sulle sole misure conservate per esteso — le prime 40 per wallet, quindi le più recenti:
campione piccolo **e** non casuale, da leggere come indicazione.

| gruppo | n | distanza/raggio q25 | mediana | q75 | fill fuori dalla banda |
|---|---|---|---|---|---|
| efficienti | 100 ⚠ | 0,14 | **0,33** | 0,92 | 22.0% |
| top 5 per rewards | 113 ⚠ | 0,11 | **0,27** | 0,44 | 8.0% |
| sensibilità | 110 ⚠ | 0,11 | **0,22** | 0,34 | 5.5% |

## ② I mercati

Insieme dei mercati toccati nel campione di trade: **374** per gli efficienti, **2613** per i primi 5.
Sovrapposizione: **34** mercati in comune, cioè il **9.1%** di quelli degli efficienti.

| `minSize` | mercati degli efficienti | mercati dei top 5 |
|---|---|---|
| 20 | 59 (58%) | 1123 (68%) |
| 30 | 0 (0%) | 20 (1%) |
| 40 | 0 (0%) | 31 (2%) |
| 50 | 38 (37%) | 260 (16%) |
| 100 | 1 (1%) | 150 (9%) |
| 200 | 4 (4%) | 65 (4%) |

| `maxSpread` | mercati degli efficienti | mercati dei top 5 |
|---|---|---|
| 2.5 | 0 (0%) | 4 (0%) |
| 3.5 | 3 (3%) | 22 (1%) |
| 4.5 | 75 (74%) | 1345 (82%) |
| 5.5 | 5 (5%) | 220 (13%) |
| 6.5 | 19 (19%) | 58 (4%) |

Volume 24 h mediano dei mercati: efficienti $325 · top 5 $1020.

## ③ Cosa fanno dopo un fill

Orizzonte di classificazione 24 h. Gli eventi troppo vicini alla fine del campione sono **censurati** ed esclusi dalle percentuali.

| | efficienti | top 5 | sensibilità |
|---|---|---|---|
| eventi classificati | 536 | 15804 | 10752 |
| censurati | 250 | 1218 | 578 |
| **A** completa la coppia | 40.9% (n=219) | 32.6% (n=5156) | 48.4% (n=5208) |
| **B** rivende lo stesso esito | 31.9% (n=171) | 13.7% (n=2171) | 6.1% (n=660) |
| **C** tiene fino alla risoluzione | 12.3% (n=66) | 15.2% (n=2405) | 15.3% (n=1643) |
| **D** aumenta sullo stesso lato | 14.2% (n=76) | 36.5% (n=5762) | 29.9% (n=3212) |
| E smonta l'altro lato | 0.7% (n=4) | 2.0% (n=310) | 0.3% (n=29) |
| quota di fill presi in taker | 5.8% | 28.0% | 25.6% |

**A — completare la coppia**

| | efficienti | top 5 | sensibilità |
|---|---|---|---|
| costo coppia mediano | 99,00¢ (n=219) | 100,00¢ (n=5156) | 100,00¢ (n=5208) |
| costo coppia q25–q75 | 97,00 – 99,00¢ | 98,00 – 102,00¢ | 98,00 – 102,00¢ |
| **quota sotto la pari (<100¢)** | **83.6%** | **37.8%** | **46.9%** |
| tempo mediano | 40 s | 4460 s | 155 s |
| entro 120 s | 68.0% | 21.5% | 47.0% |
| **completata da un ordine GIÀ a libro (maker)** | **94.1%** | **75.4%** | **71.7%** |
| fra le completate entro 120 s, quota sotto la pari | 97.3% | 2.6% | 47.7% |

**B — rivendere lo stesso esito**

| | efficienti | top 5 | sensibilità |
|---|---|---|---|
| delta mediano | -1,00¢ ⚠n=171 | -1,00¢ (n=2171) | -1,00¢ (n=660) |
| delta q25–q75 | -3,00 – 0,00¢ | -5,00 – 0,00¢ | -2,70 – 0,00¢ |
| quota in guadagno | 24.0% | 21.2% | 16.1% |
| tempo mediano | 156 s | 1012 s | 213 s |
| venduta da un ordine già a libro | 68.4% | 35.8% | 30.3% |

**D — aumentare sullo stesso lato**: tempo mediano 76 s · 5049 s · 129 s (efficienti · top 5 · sensibilità).

### Il costo realizzato dell'uscita

Segno positivo = guadagno. Una coppia chiusa a 99¢ vale **+1¢/share**, una a 102¢ vale −2¢/share.
C e D non hanno un esito realizzato: contano nella colonna «resta direzionale».

| | efficienti | top 5 | sensibilità |
|---|---|---|---|
| costo medio sugli eventi con esito (A+B) | -0,07¢ (n=390) | -0,71¢ (n=7327) | -0,05¢ (n=5868) |
| costo mediano | **1,00¢** | **-0,58¢** | 0,00¢ |
| **resta direzionale (C+D)** | **26.5%** | **51.7%** | 45.2% |
| coppie chiuse sopra la pari | 13.2% | 49.6% | 41.0% |
| …e quando sono sopra, di quanto (mediana) | 6,00¢ | 2,00¢ | 3,00¢ |
| coppie chiuse oltre 110¢ | 5.0% | 5.0% | 5.8% |
| coppie chiuse oltre 120¢ | 2.7% | 1.3% | 1.1% |

## Conclusione — cosa fanno gli efficienti che i grossi non fanno

**① NON è la distanza dal mid, e la misura va nella direzione opposta all'attesa.** Gli efficienti
quotano mediana **2,38¢** dal mid contro **1,00¢** dei primi 5 — cioè un po' **più lontano**, e con una
coda molto più larga (q90 19,50¢ contro 3,00¢). Normalizzata sul raggio della banda la differenza
si assottiglia ma non cambia segno. **La posizione nel book non è il loro vantaggio.**

**② I mercati sì, e sono quasi disgiunti.** Solo il 9.1% dei mercati degli efficienti è toccato
anche dai primi 5. Gli efficienti stanno su book **più sottili** (volume 24 h mediano $325 contro
$1020) e su bande **più larghe** (`maxSpread` 6.5 nel 19% dei loro mercati contro il 4% dei grossi):
più spazio per stare dentro la banda restando lontani dal mid, e meno concorrenza per il montepremi.

**③ La differenza vera è l'uscita, ed è doppia.**

· **Le due gambe stanno a libro insieme.** Il 94.1% delle coppie si completa con un ordine
  **già a riposo** che viene colpito, in 40 secondi mediani, e il 97.3% di quelle chiuse entro
  120 s costa **meno di $1**. Non è una reazione al fill: è una quotazione a due lati che si riempie da sola.
  Nei primi 5 la stessa cosa vale per il 21.5% delle coppie, e fra quelle veloci solo il 2.6% sta sotto la pari:
  quando i grossi chiudono in fretta, è perché **stanno attraversando lo spread**.

· **Quando la coppia non arriva, la smontano invece di pagarla.** 31.9% dei loro eventi è una rivendita
  dello stesso esito a **-1,00¢** mediani in 156 secondi, contro il 13.7% dei primi 5. Il risultato è che restano
  direzionali il **26.5%** delle volte contro il **51.7%**, e chiudono sopra la pari solo il 13.2% contro il 49.6%.

In una riga: **il costo mediano realizzato di un'uscita è 1,00¢ per gli efficienti e -0,58¢ per i primi 5.**
I grossi accumulano (D 36.5% contro 14.2%) e pagano il completamento; gli efficienti si appaiano o escono.

## La regola del bot, confrontata

⚠ **Prima una correzione di premessa: il tetto della coppia non è 110¢, è 120¢.**
`lib/maker/chiusura-rapida.js:73` — `TETTO_COPPIA_DEFAULT_CENTS = 120`, e `MAKER_TETTO_COPPIA_CENTS`
non è impostata né in `.env` né in `ecosystem.config.js`, quindi il valore in servizio è 120.
I 110¢ erano **quattro commenti rimasti indietro** dopo la modifica del 12 agosto
(`auto-close.js` righe 49, 1155, 1301, 1496) — reperto D7, §5.2 punto 28. Sono stati corretti
**da un'altra sessione in parallelo su questa stessa copia**, mentre questa misura girava.

| | il bot | gli efficienti |
|---|---|---|
| tetto della coppia ai Livelli 1-2 | **99¢** (`100 − carico − MERGE_MIN_MARGIN_CENTS`, `strategia-merge.js:45,83`) | costo mediano **99,00¢**, q75 99,00¢ |
| come si completa la coppia | Livello 1 **taker** se l'ask sta già sotto il tetto, altrimenti Livello 2 **maker** | 94.1% **maker**, 5.9% taker |
| quanto si aspetta da maker | **60 min** (`MERGE_WAIT_TIMEOUT_MIN`, `strategia-merge.js:47`) | 68.0% delle coppie si chiude entro **120 s** |
| dopo l'attesa | Livello 3: taker fin dove il book copre + limit, coppia ≤ **120¢** | coppie oltre 120¢: **2.7%** |
| vendere la gamba in perdita | vietato fino a **30 min** (`profitPct: 1`), poi al carico; **sotto** il carico solo da **120 min** e per al più 2 tick / 5% (`urgenza-scoperto.js:63,85,86`) | lo fanno in **156 s** mediani, a -1,00¢, nel 31.9% dei casi |

**Dove la regola somiglia.** Il tetto di 99¢ dei Livelli 1-2 è **esattamente** il costo mediano che
gli efficienti pagano davvero (99,00¢): il numero è tarato bene. E il Livello 2 — coppia da maker,
sotto il tetto, che intanto matura reward — è la stessa cosa che loro fanno nel 94.1% dei casi.

**Dove non somiglia, e sono due punti.**

· **L'escalation a 120¢ è una via che loro non prendono quasi mai** (2.7% delle coppie), e i primi 5
  nemmeno (1.3%). Non è un difetto — è una valvola per il caso peggiore — ma non è la leva che
  distingue chi guadagna: nessuno dei due gruppi ci vive dentro.

· **La vera differenza è che il bot non si sgancia in fretta.** La rivendita della gamba a piccola
  perdita è 31.9% del comportamento degli efficienti, a -1,00¢ mediani dopo 156 secondi. Il bot la stessa
  azione la **consente** — un tick sotto il carico rientra nei 2 tick e nel 5% del gradino 2 —
  ma **solo dopo 120 minuti di scopertura**, cioè circa **46×** più tardi. Nel frattempo il
  Livello 2 tiene un ordine di completamento a libro per un'ora.

**⚠ Quello che questa misura NON dice**: se il bot uscisse prima, incasserebbe di meno in reward
(un ordine che riposa matura, uno smontato no). Il confronto qui è sul **costo dell'uscita**, non
sul saldo fra costo d'uscita e reward maturato: quel saldo richiede il reward per mercato, che
§4.12 dà per non attribuibile (il venue paga un bonifico aggregato).


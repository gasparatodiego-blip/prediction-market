# Chi incassa i liquidity reward su Polymarket — 30 giorni, 14/07 → 12/08 2026

Sola ricerca, dati pubblici on-chain e API pubblica Polymarket. Nessuna chiave privata usata.

## Fonte e limiti, dichiarati

| | |
|---|---|
| API | **Etherscan V2 multichain**, `chainid=137`, `action=tokentx` |
| ⚠ | `api.polygonscan.com` (v1) è **dismesso** e risponde HTML — verificato, non ipotizzato |
| ⚠ | il piano gratuito tronca la pagina a **1.000 righe** e la query a **10.000 righe**: con ~2.700 destinatari/giorno una query copre 4 giorni. Serve la partizione per blocchi giornalieri, altrimenti si scambia una pagina troncata per l'ultima |
| finestra | **30 giorni completi**. Il 13/08 è escluso: la giornata non è finita e l'API rifiuta un confine nel futuro |
| buchi | **nessuno** nei 30 giorni completi |
| costo | 168 chiamate, **0 rallentamenti** per rate limit, 83 secondi |

**Due giorni anomali, marcati e non nascosti**: 15/07 ($260k, 6.563 destinatari, 17 tx) e 07/08 ($644k, 9.626, 25 tx) contro una mediana di $113k / ~2.700 / 7 tx. Hanno la firma di un recupero, non di una giornata normale.

**Scala reale**: la distribuzione non è una tx da 400 destinatari ma **7 tx al giorno per ~2.700 destinatari**. La tx citata nel brief ($19.719 a 400 indirizzi) è **una delle sette** dell'11/08, il cui totale vero è $88.538 su 2.492 destinatari.

## Il monte premi, e chi se lo prende

**$3.974.198 in 30 giorni**, 14.836 wallet distinti. Scartando il rumore (< $1 in totale **oppure** presenti un solo giorno: 5.622 wallet, l'**1,43%** del monte) restano **9.214 wallet**.

| fascia (media per giorno di presenza) | wallet | % wallet | incassato | % del monte | presenza mediana |
|---|---|---|---|---|---|
| **≥ $200/giorno** | **172** | **1,9%** | **$2.353.064** | **59,2%** | **29/30** |
| $100–200/giorno | 187 | 2,0% | $431.834 | 10,9% | 18/30 |
| $10–100/giorno | 2.359 | 25,6% | $928.374 | 23,4% | 10/30 |
| $1–10/giorno | 6.496 | 70,5% | $204.112 | 5,1% | 4/30 |

**Il grosso va a pochissimi**: i primi 10 wallet prendono il **22,5%**, i primi 100 il **52,4%**, i primi 250 il **68,0%**.

E la presenza è il discriminante più netto: chi sta nella fascia alta c'è **29 giorni su 30**; chi sta sotto i $10 c'è **4 giorni su 30**.

## Il nostro wallet

`0x4c81f19a436e8174f1f3b07d7c0169150fbdbdee`

| | |
|---|---|
| presenza | **4 giorni su 30** |
| incassato | **$17,59** |
| media per giorno di presenza | $4,40 |
| posizione | **5.596° su 9.214** ⇒ percentile **39,3** |
| quota del monte premi | **0,0004%** |

**Siamo nella metà bassa.** Non è una questione di ritmo: è che nei 30 giorni abbiamo incassato **4 volte**.

### La verifica del consuntivo: il pannello ha ragione, e anche la catena

| giorno pannello | importo | giorno catena | importo |
|---|---|---|---|
| 06/08 | $1,3042 | 07/08 | $1,3042 |
| 08/08 | $3,6792 | 09/08 | $3,6792 |
| 09/08 | $8,3524 | 10/08 | $8,3524 |
| 10/08 | $4,2525 | 11/08 | $4,2525 |
| 12/08 | $1,6628 | 13/08 | *(non raccolto: giornata incompleta)* |
| **totale** | **$19,25** | **totale** | **$17,59** |

**Ogni importo coincide a quattro decimali, sfalsato di esattamente un giorno.** Il pannello data il premio al giorno **maturato**, la catena al giorno **pagato** (la mezzanotte successiva). La differenza $19,25 − $17,59 = **$1,66** è esattamente la riga del 12/08, che sarà pagata il 13/08 — il giorno che non ho potuto raccogliere.

**Nessuno dei due sbaglia**: rispondono a due domande diverse. Il consuntivo del pannello è corretto.

## I primi 15 per incasso

| # | wallet | $/g | mercati | quota 1 gamba | valore in posizione | PnL non real. | PnL real. | taglio mediano | durata mediana |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `0xc602e347…` | $4.672 | 500 | 100% | $26.589 | −$11.363 | $23.605 | $8,57 | 23,6 min |
| 2 | `0x21ffd2b7…` | $3.986 | 478 | 95% | $186.210 | −$27.590 | $997 | $13,06 | 12,5 min |
| 3 | `0xc8ab97a9…` | $3.511 | 499 | 100% | **$1.329.853** | −$99.946 | $16.295 | $12,58 | 45,6 min |
| 4 | `0xfea31bc0…` | $3.433 | 87 | 99% | **$1.769.743** | −$49.955 | $7.497 | $16,86 | 77 h |
| 5 | `0x30fb41b5…` | $2.933 | 499 | 100% | $24.366 | −$30.596 | $5.263 | $9,10 | 43,6 min |
| 6 | `0xa3e22cd3…` | $2.593 | 498 | 100% | $11.303 | −$12.324 | $2.976 | $5,67 | 16,5 min |
| 7 | `0x6f679c4a…` | $2.585 | 500 | 100% | $12.310 | −$31.260 | $5.682 | $7,00 | 76,3 min |
| 8 | `0xbd14da50…` | $2.127 | 277 | 99% | $3.285 | −$3.694 | −$602 | $12,46 | 0,1 min |
| 9 | `0x6d57da09…` | $2.051 | 497 | 99% | $194.552 | −$40.948 | $29.866 | $8,00 | 372 min |
| 10 | `0x52ebca45…` | $1.926 | 500 | 100% | $24.010 | −$53.414 | $9.459 | $12,81 | 130 min |
| 12 | `0xf68a2819…` | $1.485 | 355 | 97% | **$550.209** | −$351.609 | $139.560 | $14,00 | 17,8 min |
| — | **NOI** | **$4** | **16** | **100%** | **$136** | −$5 | −$2 | $10,76 | 205 min |

## L'ipotesi direzionale: CONFERMATA

**Verificato prima di concluderlo**: l'API `positions` **non** compatta i lati opposti — restituisce sia `outcomeIndex 0` che `1`, e su un wallet campione un `conditionId` compare due volte. Quindi «una gamba sola» è un fatto misurato, non un artefatto.

Sui **primi 50 wallet**, quota di mercati con **entrambe** le gambe:

| wallet | reward 30gg | mercati | appaiati | quota |
|---|---|---|---|---|
| `0xbe74297f…` | $14.025 | 446 | 54 | **12,1%** ← il massimo |
| `0x17f4b0fe…` | $14.929 | 455 | 45 | 9,9% |
| `0xb3078bcc…` | $11.141 | 132 | 8 | 6,1% |
| `0x7ae4b06f…` | $14.495 | 134 | 7 | 5,2% |
| tutti gli altri 46 | — | — | — | **< 5%** |

**Solo 4 wallet su 50 superano il 5% di mercati appaiati, e il massimo assoluto è il 12,1%.** Nessuno dei top gestisce un libro neutrale.

**Aggregato dei primi 50**: **$6,74 M** in posizione contro **$1,65 M** di reward in 30 giorni. Il capitale impegnato è **quattro volte** il premio che incassano: i reward sono un sottoprodotto del tenere size a libro su mercati su cui hanno una view, non il ricavo principale.

⚠ **Il PnL va letto con cautela e non lo uso per concludere**: `cashPnl` e `realizedPnl` dell'API sono **cumulativi sulla vita della posizione**, non ritagliabili sui 30 giorni, e includono posizioni ormai prive di valore. L'aggregato (−$40,8 M non realizzato) **non** significa «hanno perso $40 M in 30 giorni». Il dato solido è la **quota di gambe singole** e la **scala del capitale**, non il PnL.

**Risposta alla domanda «esiste un neutrale come noi fra i top?»: NO.** Il più appaiato dei 50 sta al 12,1%, cioè l'88% dei suoi mercati resta direzionale.

## I 21 wallet già studiati, oggi

**20 su 21 esistono ancora, ma nessuno è un top incassatore.**

| nome | $/g dichiarato (v2) | giorni | totale 30gg | media/g | rango |
|---|---|---|---|---|---|
| Anon | $137,50 | 22/30 | $9.095 | $413 | **67°** ← il migliore |
| 0x71a5B653 | $132,32 | 22/30 | $8.480 | $385 | 71° |
| lmtscapt | $115,95 | 21/30 | $8.084 | $385 | 78° |
| 0xF0e02A54 | $131,59 | 30/30 | $7.326 | $244 | 91° |
| Gurupolimarket | $151,89 | 25/30 | $5.175 | $207 | 135° |
| Flashwhisky | $86,23 | 30/30 | $5.345 | $178 | 131° |
| cedrocoffee | $66,96 | 29/30 | $4.388 | $151 | 157° |
| jjjjjsda | $113,41 | 28/30 | $2.825 | $101 | 223° |
| …altri 12 | | | | $8–136 | 292°–4.728° |
| **Lilybaeum** | $0,01 | **0/30** | — | — | **sparito** |

Il migliore dei 21 è **67°**; la maggior parte sta fra il 100° e il 400° posto. **Il manuale operativo descrive la seconda fascia, non i top.** Chi è calato: `LondonBridge` (4.728°, $8/giorno), `alvaro25011` (presente 2 giorni su 30), `NovaB` (13/30). Chi è sparito: **Lilybaeum**, zero presenze in 30 giorni.

## Le differenze che contano, con i numeri

| # | differenza | noi | i top | replicabile a $650? |
|---|---|---|---|---|
| 1 | **presenza** | 4/30 giorni | 29-30/30 | **SÌ, ed è la più grande** |
| 2 | **mercati simultanei** | 16 | 277–500 | **NO** — 500 mercati al nostro tetto di $32,67 sono $16.335 |
| 3 | **capitale in posizione** | $136 | $3.285 – $1,77 M | **NO** |
| 4 | **direzionalità** | neutrali (per scelta) | 88-100% a gamba singola | **NO, e non va replicata** |
| 5 | **taglio dell'ordine** | $10,76 | $5,67 – $16,86 | **già allineati** |

## Conclusioni operative

**① La presenza è l'unica differenza replicabile, ed è la più grande.**
Siamo stati presenti **4 giorni su 30**. Chi prende ≥$200/giorno c'è **29 su 30**. Il taglio dei nostri ordini ($10,76 mediano) è **già dentro** il range dei top ($5,67–$16,86): non è la dimensione a mancare, è la continuità. Le cause dei 26 giorni di assenza sono già documentate in questo repo — il deadlock aritmetico di §120 (3 ore), i tre falsi positivi del guardiano, i residui bloccati.
**Valore stimato**: portare la presenza da 4/30 a ~25/30 mantenendo i $4,40/giorno attuali darebbe **~$110/mese invece di $17,59**. ⚠ **Incertezza: alta**, perché $4,40 è la media di 4 giorni soli.

**② Il taglio dell'ordine non è il problema, e non va toccato.** Misurato, non dedotto.

**③ La scala dei top non è replicabile, e non per poco.** Il primo wallet tiene $1,77 M in posizione — **2.700 volte** il nostro capitale. Anche il più piccolo dei primi 50 tiene $318 in posizione su 134 mercati. **Non esiste una versione annacquata**: con $650 non si sta su 500 mercati.

**④ La strategia dei top è un'altra strategia, e copiarne i parametri non porta i loro incassi.**
Il 96% dei primi 50 tiene meno del 5% dei mercati appaiati. Prendono i reward **quotando size su mercati su cui hanno una view direzionale**, con $6,74 M aggregati in posizione contro $1,65 M di premi. **Il nostro modello — market making neutrale — è deliberatamente un'altra cosa**, e il confronto sul $/giorno confronta due mestieri diversi.

**⑤ Il manuale operativo va riletto sapendo chi descrive.** I 21 wallet stanno fra il 67° e il 4.728° posto. Sono un riferimento ragionevole per la nostra fascia, **non** un modello dei top. Uno è sparito e tre sono crollati: le loro strategie hanno smesso di funzionare, ed è un'informazione utile quanto quella di chi cresce.

**Nessun parametro è stato modificato.** Ogni cambiamento di configurazione è una decisione dell'operatore.

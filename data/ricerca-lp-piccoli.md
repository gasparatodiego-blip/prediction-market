# Liquidity provider piccoli e redditizi — cosa fanno che noi non facciamo

Ricerca del 7 agosto 2026. **Solo letture pubbliche**: `polyrewards.fun` (file statici) e
`data-api.polymarket.com` (non autenticata). Nessun ordine, nessuna chiave, nessuna modifica al motore.

---

## Dove sono i dati della leaderboard

`polyrewards.fun` non ha un'API REST: la pagina scarica **file JSON statici**. Trovati leggendo le
`fetch()` nello script inline della home:

| file | contenuto |
|---|---|
| `https://polyrewards.fun/top1000.json` | 1000 righe `{rank, name, address, rewards}` — **indirizzi completi** |
| `https://polyrewards.fun/meta.json` | `total: 161.969` wallet, soglie, `generated_at` |
| `/top10.json`, `/top1.json`, `/all.json`, `/daily/<shard>.json` | tagli e serie giornaliere |

`rewards` è **cumulativo**, non recente. Il dato «reward degli ultimi 7/30 giorni» non sta lì: l'ho
ricostruito dagli eventi `REWARD` di `data-api.polymarket.com/activity`, che portano `usdcSize` e un
`transactionHash` — pagamenti veri, verificati su un record grezzo prima di usarli.

---

## FASE 1 — selezione

Partenza: 117 wallet nella fascia $8.5k–12k di reward cumulativi (rank 343–459), più i 5 nomi indicati.
Screening su 38 wallet (`/value` + `/trades`), filtri: reward ≥ $9k · attività ≤ 14 giorni · capitale ≤ ~$2k.

### Selezionati — 5 wallet

| wallet | rank | reward cum. | valore posizioni | ultimo trade |
|---|---|---|---|---|
| **0x71a5B653…C1B594** | 350 | $11.626 | $1.019 | 1.2 g |
| **happy666** `0xd17e2edc…` | 361 | $11.159 | $843 | oggi |
| **0xF0e02A54…280016A** | 365 | $11.094 | $552 | oggi |
| **Anon** `0x4a1a27c4…` | 372 | $10.969 | $7 | 3.6 g |
| **PersonalRush** `0x2a6db57a…` | 406 | $9.981 | $790 | 1.8 g |

**PersonalRush è ancora operativo**, contrariamente all'ipotesi di partenza: 740 fill negli ultimi 90
giorni, l'ultimo 1.8 giorni fa. Resta però il meno redditizio del gruppo — vedi sotto.

### Scartati, e perché

| wallet | motivo |
|---|---|
| Bikesarethebest `0x0a6d26d3…` | capitale $100.009 — due ordini di grandezza sopra il filtro |
| wokerjoesleeper `0x63d43bbb…` | capitale $632.536, e fermo da 8.5 giorni |
| videlake `0x6ae15752…` | capitale $298.150 |
| Razirback `0x92c78d8f…` | capitale $8.133 **e** fermo da 8.7 giorni |
| NonceChaser, mombil, Clenc, wan123, ThatsWhatXiSaid, crbmnc, gcmcrb, leegunner | capitale da $100k a $1.09M |
| ujaKanga, BunnyRun, Evador, Spice, FallLine, JustZen, Po1yamory, payooo | ex-operatori: fermi da 68–527 giorni |

I quattro nomi della fascia $9.9k indicati nel brief hanno tutti **capitale grande**: hanno fatto $9k
con decine o centinaia di migliaia di dollari, non con mille. Il gruppo davvero comparabile con noi è
quello selezionato sopra, trovato scendendo la fascia.

**sxmachine** `0xe84f8e41…` resta come archetipo opposto, fuori filtro (capitale $1.804 ma profilo
completamente diverso).

---

## FASE 2 — profilo operativo

Finestra: 90 giorni. `/trades` paginato, `/positions`, `/activity`.

| | **0x71a5B653** | **happy666** | **0xF0e02A54** | **Anon** | **PersonalRush** | *sxmachine* |
|---|---|---|---|---|---|---|
| fill / 90 g | 949 | 750 | 1.354 | 332 | 740 | 6.000+ |
| **fill al giorno** | **11,1** | **15,8** | **15,8** | 3,9 | 8,6 | **4.705** |
| mercati toccati | 680 | 280 | 870 | 262 | **24** | 1.065 |
| size mediana (share) | 100 | 64 | 52 | 268 | 500 | 7 |
| **nozionale mediano** | **$45,60** | **$31,18** | **$14,00** | $225,86 | $156,52 | **$3,40** |
| prezzo mediano di fill | 0,48 | 0,51 | 0,37 | 0,98 | 0,19 | 0,60 |
| **fill fra 40 e 60¢** | **62,2%** | 26,9% | 23,9% | 6,6% | 2,2% | 28,7% |
| BUY / SELL | 475 / 474 | 300 / 450 | 42 / 1.312 | 327 / 5 | 344 / 396 | 6.000 / 0 |
| cicli BUY→SELL chiusi | 49 | 77 | 34 | 4 | 309 | 0 |
| ore mediane per ciclo | 12,1 | 7,3 | 83,9 | 0,5 | **0,0** | — |
| margine mediano ciclo | **0,0¢** | −3,0¢ | −2,2¢ | +8,0¢ | −0,17¢ | — |
| mercati con **entrambi** i lati | 4,3% | 1,1% | 5,5% | 0,4% | **29,2%** | **42,1%** |
| **MERGE (90 g)** | **0** | **0** | **0** | **19** | **9** | 0 |
| REDEEM (90 g) | 30 | 21 | 0 | 60 | 17 | 44 |
| ore attive su 24 | 24 | 20 | 24 | 18 | 20 | 24 |
| giorni con trade | 66/86 (77%) | 48/47 (100%) | 79/85 (93%) | 59/86 (69%) | 28/86 (33%) | — |
| categorie prevalenti | sport 57% | generici | generici, politica 19% | **sport 79%** | generici | sport 66% |

### Classificazione

- **0x71a5B653 — maker puro bilanciato.** BUY e SELL quasi identici (475/474), margine mediano
  **esattamente 0,0¢**, ciclo 12 ore, e **62% dei fill fra 40 e 60 centesimi**. Non specula: sta su
  entrambi i lati vicino al mid e incassa il reward. 680 mercati in 90 giorni. È il profilo più vicino
  a quello che stiamo costruendo, ed è il più istruttivo.
- **happy666 — maker con rotazione veloce.** 15,8 fill/giorno, ciclo 7,3 ore, margine −3¢: perde un
  filo sul prezzo e guadagna sul reward. **Trade tutti i giorni**, 280 mercati.
- **0xF0e02A54 — venditore quasi puro.** 1.312 SELL contro 42 BUY. Con 0 SPLIT e 0 REDEEM registrati
  nella finestra, il collaterale viene da fuori: il profilo non si spiega solo con i trade osservabili.
  Nozionale mediano **$14**: size minuscole, 870 mercati.
- **Anon — taker su sport quasi risolti.** Prezzo mediano **0,98**, 79% sport, 327 BUY contro 5 SELL,
  60 REDEEM. Compra quasi-certezze e aspetta il rimborso. Non è market making.
- **PersonalRush — completatore di coppia e merger.** L'unico con ciclo **0,0 ore** e margine −0,17¢:
  BUY e SELL sullo stesso asset nello stesso istante, cioè entrambi i lati della sua quota vengono
  presi insieme. **29% dei mercati con entrambi i lati**, 9 MERGE e 17 REDEEM. Solo **24 mercati** in
  90 giorni e trade in 1 giorno su 3.
- **sxmachine — archetipo opposto.** 4.705 fill/giorno, size mediana 7 share, **$3,40** di nozionale
  per fill, 1.065 mercati, 42% su entrambi i lati, 24h su 24. Polverizzazione estrema.

---

## Il merge: chi lo usa davvero

**Il risultato è controintuitivo.** I tre wallet a rendimento più alto — 0x71a5B653, happy666,
0xF0e02A54 — hanno **zero MERGE in 90 giorni**. Lo usano i due meno redditizi: PersonalRush (9 merge,
$118 di reward in 30 giorni) e Anon (19 merge, ma è un taker su sport, non un LP).

Chi fa reward con poco capitale **non lo fa con il merge**: lo fa con l'ampiezza e con size piccole.
Il merge resta uno strumento corretto per liberare capitale, ma i dati non lo indicano come la leva
che spiega la differenza di rendimento.

---

## FASE 3 — confronto e target

**Noi:** ~$620 di capitale, 4–6 mercati politici a 12–24 giorni, 2 fill nel primo pomeriggio,
$1,18 + $1,30 pagati il primo giorno reale ⇒ **~0,2–0,4 %/giorno**.

| | reward 30 g | reward 7 g | valore posizioni | **%/giorno (7 g)** |
|---|---|---|---|---|
| 0xF0e02A54 | $6.364 | $1.291 | $552 | ~33% |
| happy666 | $8.278 | $932 | $843 | ~16% |
| 0x71a5B653 | $7.494 | $1.070 | $1.019 | ~15% |
| PersonalRush | $118 | $33 | $790 | ~0,6% |
| **noi** | — | ~$2,5 | ~$620 | **~0,3%** |

> **Il denominatore è il punto debole di questa tabella e va detto.** `/value` misura le posizioni
> aperte *adesso*, non il capitale che ruota nella giornata. Chi gira il capitale più volte al giorno
> ha un `/value` più basso del capitale che sta davvero impiegando, quindi quei 15–33% sono un **tetto
> superiore**, non una misura pulita. Il capitale operativo vero sta probabilmente fra $1.000 e $3.000
> per tutti e tre (80 posizioni × $14 = $1.120 per 0xF0e02A54; 57 × $46 = $2.600 per 0x71a5B653), il
> che riporterebbe il rendimento reale in una fascia **~5–12 %/giorno**. Resta comunque un ordine di
> grandezza sopra il nostro.

### Le tre risposte

**1. Rendimento reale dei migliori piccoli operatori oggi?**
$1.000–$1.300 di reward a settimana su un capitale operativo stimato $1.000–$2.600, cioè
**~5–15 %/giorno** — prendendo la fascia bassa come la più credibile. PersonalRush allo 0,6% mostra che
questa fascia **non è automatica**: dipende dal metodo, non dall'essere piccoli.

**2. Che capitale serve per $30/giorno?**
- al loro rendimento prudente (5%/g): **~$600** — cioè il capitale che abbiamo già
- al loro rendimento ottimistico (15%/g): ~$200
- **al nostro rendimento attuale (0,3%/g): ~$10.000**

Il divario non è di capitale. È di metodo: con $620 il target è raggiungibile, oggi non lo stiamo
raggiungendo.

**3. Quali comportamenti spiegano la differenza?**

- **Ampiezza.** Loro toccano **280–870 mercati** in 90 giorni; noi 4–6. Il reward è una quota di un
  montepremi per mercato: essere su cento mercati piccoli paga più che essere su cinque grandi, perché
  su ognuno la concorrenza è minore e la quota nostra più alta.
- **Size piccole e molte.** Nozionale mediano **$14–46 per fill**; il nostro ordine tipico è $39–195 su
  un solo mercato. Frammentare lo stesso capitale su più mercati aumenta il montepremi totale a cui si
  partecipa, a parità di dollari.
- **Stare vicino al mid.** 0x71a5B653 ha il **62% dei fill fra 40 e 60 centesimi** e margine di ciclo
  **0,0¢**: accetta di non guadagnare nulla sul prezzo e prende tutto dal reward. La nostra regola
  «mai primo sul libro» più il pavimento di profondità al 10% ci spingono nella direzione opposta —
  più indietro nella coda, dove il punteggio è più basso.
- **Continuità.** happy666 fa trade **tutti i giorni**, 0xF0e02A54 il 93% dei giorni, su 20–24 ore.
  Noi abbiamo il kill switch attivo e 2 fill in un pomeriggio.

*(Elenco osservativo. Nessuna modifica al motore è stata fatta o proposta qui.)*

---

## Limiti di metodo, dichiarati

1. **Gli ordini a riposo di terzi non sono osservabili.** La «distanza dal mid» è **dedotta** dalla
   frequenza dei fill e dalla distribuzione dei prezzi eseguiti, non misurata.
2. **`/activity` senza filtro tronca a 500 eventi**, quindi i conteggi per tipo sono un limite
   inferiore. I conteggi MERGE/REDEEM/REWARD qui sopra vengono dalle serie filtrate per tipo
   (332, 104, 78, 73, 40 eventi: tutte **sotto** il limite, quindi complete nella loro finestra).
3. **Il capitale operativo non è osservabile**: `/value` è una fotografia delle posizioni aperte. Ogni
   percentuale di rendimento va letta con la cautela del riquadro sopra.
4. **La categorizzazione dei mercati** è euristica sui titoli: «generici» raccoglie ciò che non ricade
   in sport/crypto/politica, quindi le quote per categoria vanno prese come indicative.
5. `sxmachine` non è nella top-1000, quindi il suo reward cumulativo non è noto; il suo campione di
   6.000 fill copre solo ~3 giorni per via del limite di paginazione.

# Setaccio sistematico: quanti "maker puri" piccoli e attivi esistono davvero

7 agosto 2026. Seguito di `ricerca-lp-piccoli.md`. **Solo letture pubbliche** (`polyrewards.fun`,
`data-api.polymarket.com`), nessuna chiave, nessun ordine, nessuna modifica al motore.

## Definizione operativa usata

Un wallet passa se rispetta **tutti e sei** i criteri, misurati sugli **ultimi 90 giorni**:

| # | criterio | soglia |
|---|---|---|
| 1 | attivo | ultimo trade ≤ 3 giorni |
| 2 | capitale piccolo | `/value` ≤ $3.000 |
| 3 | bilanciato | BUY/SELL fra 0,7 e 1,3 |
| 4 | vicino al mid | ≥ 50% dei fill fra 35¢ e 65¢ |
| 5 | frequente | ≥ 5 fill/giorno |
| 6 | ampio | ≥ 100 mercati distinti |

Universo: i **864 wallet** di `top1000.json` con reward cumulativi fra $3.000 e $30.000
(rank 137–1000). **Esaminati tutti e 864.**

---

## Un difetto del setaccio, trovato e corretto

Il primo giro ha restituito **0 trovati su 864**. Prima di riportarlo l'ho validato contro il caso che
so avere quel profilo, 0x71a5B653 — e **veniva scartato anche lui**, dal filtro 3.

La causa era mia. Il pre-screening giudicava bilanciamento e vicinanza al mid su **una sola pagina di
500 fill**, che per un maker frequente copre ~50 giorni, non 90. Su un wallet che alterna fasi di
accumulo e di distribuzione quel taglio ribalta il verdetto:

| finestra | BUY | SELL | rapporto | verdetto |
|---|---|---|---|---|
| 1 pagina (~50 g) | 154 | 346 | **0,445** | scartato |
| 90 giorni | 477 | 474 | **1,006** | passa |

I filtri sono definiti sui 90 giorni e vanno misurati sui 90 giorni. Corretto l'ordine — capitale →
attività/frequenza (economici, una pagina) → paginazione **piena** per bilanciamento, mid e mercati —
il setaccio ritrova 0x71a5B653 e altri due. **Il "0 trovati" era un artefatto, non un risultato.**

## Esito dello screening

**3 wallet passano tutti e sei i criteri: lo 0,35% dell'universo.**

| filtro che ha scartato | wallet |
|---|---|
| 2 · capitale > $3.000 | **379** |
| 1 · nessun fill negli ultimi 90 g | 168 |
| 1 · fermo da > 3 giorni | 159 |
| 3 · BUY/SELL sbilanciato | 105 |
| 5 · < 5 fill/giorno | 34 |
| 4 · < 50% dei fill fra 35–65¢ | 14 |
| `/value` illeggibile | 2 |
| **passano** | **3** |

Il profilo è **raro**: quasi metà dei wallet con reward provati ha capitale grande, e di quelli piccoli
la maggioranza è ferma o sbilanciata.

---

## Le tre schede

### 0x71a5B653…C1B594 — il maker puro
`0x71a5b65336ef41585cce33e49073742be8c1b594` · rank 352

- **Reward** $11.626 cumulativi · **$7.494 in 30 g** · $1.070 in 7 g · capitale `/value` **$1.070**
- **Primo trade 12 gennaio 2026** → **207 giorni** di vita, 1.432 fill storici → **$56,14/giorno medi**
- 951 fill in 87 g = **10,9/giorno** · BUY 477 / SELL 474 → **BS 1,006**
- Prezzi p10/Q1/**mediana**/Q3/p90: 0,23 / 0,40 / **0,48** / 0,54 / 0,63 · **74,3%** fra 35 e 65¢
- **682 mercati** · size mediana 100 share · **nozionale mediano $45,60**
- 49 cicli BUY→SELL, ciclo 12,1 h, **margine mediano 0,0¢**
- 24 h su 24 · **77% dei giorni** attivi · **0 merge** · sport 57%, generici 41%

Il margine esattamente zero è la firma: **non guadagna dal prezzo, guadagna solo dal reward.**

### Nopants — il maker che fonde
`0x94a5c8d234ca67c4fba9ee99619c88f547654eb8` · rank 503

- **Reward** $7.753 cumulativi · **$1.271 in 30 g** · $137 in 7 g · capitale **$416**
- **Primo trade 15 marzo 2025** → **509 giorni** di vita, 2.415 fill storici → **$15,23/giorno medi**
- 817 fill in 89 g = **9,2/giorno** · BUY 447 / SELL 370 → BS 1,208
- Prezzi 0,19 / 0,38 / **0,537** / 0,69 / 0,84 · **51,9%** fra 35 e 65¢
- **497 mercati** · size mediana 50 · **nozionale mediano $24,50**
- 93 cicli, ciclo **1,2 h**, **margine mediano +20,0¢**
- 22 h su 24 · **91% dei giorni** attivi · **109 merge in 90 giorni** · generici 54%, sport 43%

**Più di un merge al giorno.** È il contro-esempio alla conclusione del report precedente: qui il merge
è sistematico, su un wallet piccolo e redditizio.

### wesquezz — il più veloce, e il più giovane
`0xe41c4cc0d910a6f44b1fc85c42cd3ad82039afab` · rank 667

- **Reward** $5.518 cumulativi · **$2.062 in 30 g** · **$1,41 in 7 g** · capitale **$72**
- **Primo trade 29 maggio 2026** → **70 giorni** di vita, 1.302 fill → **$79,17/giorno medi**
- 1.302 fill in 69 g = **18,8/giorno** · BUY 729 / SELL 573 → BS 1,272
- Prezzi 0,30 / 0,44 / **0,54** / 0,67 / 0,92 · **59,4%** fra 35 e 65¢
- **835 mercati** · size mediana 77 · **nozionale mediano $47,18**
- 229 cicli, ciclo **2,2 h**, **margine mediano +32,0¢**
- 24 h su 24 · **100% dei giorni** attivi · 0 merge · sport 74%

$5.518 in 70 giorni: **il più rapido ad accumulare**. Ma i reward degli ultimi 7 giorni sono **$1,41**
contro $2.062 nei 30: qualcosa si è fermato la settimana scorsa e i dati pubblici non dicono cosa.
Da non usare come modello finché non si spiega.

---

## Tabella comparativa

| | 0x71a5B653 | Nopants | wesquezz | **noi** |
|---|---|---|---|---|
| reward cumulativi | $11.626 | $7.753 | $5.518 | ~$2,5 |
| **giorni di vita** | **207** | **509** | **70** | 1 |
| reward/giorno medi | $56,14 | $15,23 | $79,17 | ~$2,5 |
| reward 30 g | $7.494 | $1.271 | $2.062 | — |
| capitale `/value` | $1.070 | $416 | $72 | ~$620 |
| fill/giorno | 10,9 | 9,2 | 18,8 | **~2** |
| **mercati (90 g)** | **682** | **497** | **835** | **4–6** |
| nozionale mediano | $45,60 | $24,50 | $47,18 | ~$39–195 |
| size mediana | 100 | 50 | 77 | 60–300 |
| % fill 35–65¢ | 74,3% | 51,9% | 59,4% | n/d |
| BUY/SELL | 1,006 | 1,208 | 1,272 | — |
| margine di ciclo | **0,0¢** | +20,0¢ | +32,0¢ | — |
| ore attive / 24 | 24 | 22 | 24 | ciclo 5 s |
| % giorni attivi | 77% | 91% | 100% | — |
| merge (90 g) | 0 | **109** | 0 | 1 (manuale) |

---

## La ricetta — cosa hanno in comune tutti e tre

Questi sono i parametri su cui **non** divergono. Sono il requisito, non lo stile:

1. **Centinaia di mercati.** 497–835 in 90 giorni. Nessuno sta sotto i 100 (era il filtro), ma nessuno
   dei tre sta neanche vicino: il minimo osservato è **cinque volte** la soglia. Noi: 4–6.
2. **Nozionale piccolo e uniforme.** $24–47 per fill, size 50–100 share. Nessuno concentra.
3. **Presidio della fascia centrale.** Mediana dei fill fra 0,48 e 0,54; dal 52% al 74% dei fill fra
   35 e 65¢. Il quartile inferiore non scende mai sotto 0,38.
4. **Continuità quasi totale.** 22–24 ore su 24, dal 77% al 100% dei giorni con trade.
5. **Frequenza 9–19 fill/giorno**, cioè **1–2 fill al giorno per ogni $100 di capitale** per i due con
   capitale misurabile (0x71a5B653: 1,0 · Nopants: 2,2).
6. **Rapporto mercati/capitale fra 0,6 e 1,2 mercati per dollaro** (682/$1.070 e 497/$416).

## I gradi di libertà — dove differiscono

Qui divergono, quindi **non** sono parte del requisito:

- **Il margine di ciclo.** 0,0¢ · +20¢ · +32¢. Solo 0x71a5B653 è un maker puro nel senso stretto; gli
  altri due prendono anche il movimento del prezzo. Si può fare reward in entrambi i modi.
- **Il merge.** 0 · 109 · 0. Non è né necessario né inutile: è una scelta.
- **La durata del ciclo.** 1,2 h · 2,2 h · 12,1 h.
- **Le categorie.** Sport 43–74%, ma nessuno è monotematico.
- **L'anzianità.** 70 · 207 · 509 giorni.

## In quanto tempo sono arrivati lì

- **wesquezz**: $5.518 in **70 giorni** — $79/giorno medi, il più rapido
- **0x71a5B653**: $11.626 in **207 giorni** — $56/giorno medi
- **Nopants**: $7.753 in **509 giorni** — $15/giorno medi, il più lento ma il più longevo

Nessuno dei tre ha fatto $10k in poche settimane. Il più veloce ha impiegato **oltre due mesi** per
arrivare a $5,5k, e lo ha fatto con un ritmo (19 fill/giorno su 835 mercati) che è dieci volte il
nostro.

---

## Stima onesta per il nostro capitale

**Il caso più utile è Nopants**, perché è l'unico i cui numeri reggono senza correzioni: capitale
$416 misurato, $1.271 di reward in 30 giorni ⇒ **$42/giorno**. Con **meno capitale del nostro**.

Quindi: **$30/giorno con $620 è raggiungibile** — c'è un wallet vivo che fa di più con due terzi del
capitale. Cosa implicherebbe per noi, applicando la ricetta:

| parametro | ricetta osservata | per i nostri $620 |
|---|---|---|
| mercati simultanei | 0,6–1,2 per dollaro | **400–700 mercati in 90 giorni** |
| nozionale per fill | $24–47 | ~$35 |
| posizioni contemporanee | — | **~18 da $35** invece di 4–6 da $100+ |
| fill/giorno | 1–2 per $100 | **6–13/giorno** invece di 2 |
| copertura oraria | 22–24 h | continua |

**Rendimento plausibile.** Prendendo Nopants come riferimento prudente (10,2%/giorno su capitale
misurato) e non i 23–95%/giorno dei due con denominatore inaffidabile: **~$60/giorno** con $620.
Il target di $30 sta a metà di quella stima, il che lascia margine all'errore di misura.

> **Il limite di questa stima, dichiarato.** `/value` fotografa le posizioni aperte *adesso*: per chi
> ruota il capitale è più basso del capitale davvero impiegato. wesquezz con $72 di `/value` e $47 di
> nozionale mediano su 835 mercati sta chiaramente movimentando molto più di $72. Le percentuali sono
> quindi un **tetto superiore**. Il numero su cui mi fiderei è quello assoluto di Nopants — $42/giorno
> con $416 di posizioni aperte — non la percentuale.

## Limiti di metodo

1. **Gli ordini a riposo di terzi non sono osservabili.** La vicinanza al mid è **dedotta** dai prezzi
   eseguiti, non misurata sugli ordini.
2. **I conteggi `redeem` sono troncati** al limite di 200 della query: per tutti e tre risulta
   esattamente 200, quindi è un limite inferiore. I `merge` (0, 109, 0) sono sotto il limite e
   completi.
3. **`/value` non è il capitale operativo** (vedi riquadro sopra).
4. **L'universo è il top-1000 di polyrewards**, cioè chi ha già ≥$3.386 cumulativi: un maker piccolo
   partito da poco e ancora sotto quella soglia non è in questa lista.
5. **wesquezz ha un'anomalia non spiegata** ($1,41 di reward in 7 giorni contro $2.062 in 30).
6. La categorizzazione dei mercati è euristica sui titoli.

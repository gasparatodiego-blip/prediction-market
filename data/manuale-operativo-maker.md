# Manuale operativo dei maker vincenti

Ricostruzione completa del ciclo operativo di quattro wallet di riferimento, su **360 giorni** (o
l'intera vita, dove più corta). Solo letture pubbliche: `data-api.polymarket.com`,
`clob.polymarket.com/prices-history`, `gamma-api.polymarket.com`. Nessun ordine, nessuna modifica al
motore.

Raccolti: **6.487 fill**, 1.604 eventi non-trade (reward, redeem, merge, split, rebate, yield),
**4.229 mercati** con metadati Gamma su 4.247 toccati, **799 serie storiche di prezzo** al minuto,
120 mercati campionati per l'affollamento.

---

## In una pagina: le tre cose che cambiano tutto

**1 · Il capitale vero è 4–45 volte quello che mostra `/value`.** È l'errore che invalidava il report
precedente. `/value` fotografa le posizioni aperte *adesso*; chi ruota il capitale ogni poche ore
appare con un denominatore quasi vuoto. Ricostruito dalla sequenza dei fill, il capitale medio
impegnato sta fra **$3.800 e $29.000**, non fra $72 e $1.070.

**2 · Di conseguenza il rendimento per dollaro è ordinario: $2,4–$14,6 al giorno ogni $1.000.**
Non il 10–95%/giorno che sembrava. E qui la notizia buona: **noi siamo già dentro quella forchetta.**
Il nostro primo giorno reale — $2,48 su $620 — vale **$4,00 per $1.000 al giorno**, in linea con
Nopants e sopra il limite inferiore osservato. *Il divario con loro non è di tecnica per dollaro: è
di capitale e di numero di mercati.*

**3 · Non lavorano sui mercati che lavoriamo noi.** La scadenza mediana al momento del primo fill è
di **0,26–0,63 giorni** per tre dei quattro: entrano su mercati che chiudono entro poche ore, li
lasciano risolvere e incassano. Noi stiamo su mercati politici a 12–24 giorni. È la differenza
strutturale più grande di tutto il documento.

---

## Le quattro schede

### 0x71a5B653 — `0x71a5b65336ef41585cce33e49073742be8c1b594`

Il maker che nel setaccio precedente aveva margine di ciclo zero. Vive di reward puri.

| | |
|---|---|
| Primo trade | 12 gen 2026 · **207 giorni** di vita |
| Fill (360g) | 1.432 · 792 BUY / 640 SELL · rapporto **1,24** |
| Reward (360g) | **$11.627** = $55,90/giorno = **$8,12 per fill** |
| Rebate maker | $414 · yield $6 |
| Capitale medio impegnato | **$3.827 … $23.515** (forchetta, vedi *Limiti*) |
| Picco | $11.010 (modello prudente) |
| Rendimento | **1,46% … 0,24% al giorno** → **$14,6 … $2,4 per $1.000/giorno** |
| Nozionale ruotato | $137.011 = **5,8×** il capitale medio |
| Nozionale mediano per fill | **$40,03** (Q1–Q3 $19,6–$94,0) · size mediana 91,5 share |
| Mercati toccati | **934** · 5 nuovi al giorno · 143 giorni con trade su 207 (69%) |
| Scadenza al primo fill | **0,43 giorni** (Q1–Q3 0,17–2,91) |
| Montepremi del mercato | mediana **$62/giorno** (Q1–Q3 $3–$906) |
| Banda premiante | 4,5¢ mediana (236 mercati a 4,5 · 179 a 2,5) |
| Categorie | sport 477 · **esport 214** · altro 184 · politica 24 |
| Ore operative | 16 ore ≥2% del volume · picco h14 UTC · vuote 4,6,8,9,11 |
| **Distanza dal mid** (pre-fill) | BUY **0,5¢** (Q1–Q3 0,5–2,0) · SELL **0,5¢** (0,5–1,5) |
| Frazione della banda | **0,22 BUY · 0,20 SELL** |
| Chiusura | **redeem 552** · ancora aperto/scaduto 308 · vendita 74 |
| Durata ciclo | 20,3 h mediana (Q1–Q3 6,7–227,9) |
| Cicli in perdita | 7,8% · mediana −$8,57 · peggiore −$185,82 · dopo 45,6 h |
| Affollamento | 135 wallet distinti mediani per mercato (min 3, max 483) · loro quota 0,2% dei trade |

Non fonde mai (0 merge in 360 giorni). Non vende quasi mai: **il 74% dei mercati si chiude a
redeem**, cioè lascia risolvere. Il P&L di trading è **negativo (−$816)**: il guadagno è tutto
reward. È la definizione operativa di «maker puro».

### Nopants — `0x94a5c8d234ca67c4fba9ee99619c88f547654eb8`

Il più anziano e il più lento per dollaro. L'unico che fonde sistematicamente.

| | |
|---|---|
| Primo trade | 15 mar 2025 · **356 giorni** nella finestra |
| Fill | 2.387 · 1.805 BUY / 582 SELL · rapporto **3,10** |
| Reward | **$6.690** = $18,74/giorno = $2,80 per fill · rebate $652 |
| Capitale medio | **$14.622 … $29.426** · picco $38.008 (prudente) |
| Rendimento | **0,13% … 0,06% al giorno** → **$1,3 … $0,6 per $1.000/giorno** |
| Nozionale ruotato | $133.968 = 4,6× |
| Nozionale per fill | **$28,04** (Q1–Q3 $13,5–$48,0) · size 60 share |
| Mercati | **1.760** · 6 nuovi/giorno · 182 giorni con trade (51%) |
| Scadenza al primo fill | **0,63 giorni** (Q1–Q3 0,17–7,03) |
| Montepremi | mediana **$3/giorno** (Q1–Q3 $0,001–$100) |
| Banda | 4,5¢ (1.020 mercati) |
| Categorie | **sport 1.113** · altro 464 · esport 126 · politica 52 |
| Ore | 16 ore ≥2% · picco h8 UTC · dorme 23–04 UTC |
| Distanza dal mid | BUY **1,5¢** (0,5–2,8) · SELL **0,75¢** (0,5–2,0) |
| Frazione di banda | **0,34 BUY · 0,22 SELL** |
| Chiusura | aperto/scaduto 1.145 · **redeem 508** · vendita 82 · **merge 25** |
| Durata ciclo | 17,4 h (Q1–Q3 6,4–38,2) |
| Perdite | 6,3% · mediana −$1,00 · peggiore −$41,17 · **tagliate dopo 0,83 h** |
| P&L di trading | **+$694** |
| Affollamento | 97 wallet mediani |

**I merge (123 in 360 giorni, 24 con costo ricostruibile):** coppia mediana a **99,66¢**, Q1–Q3
89,78–100,27. Il **54%** sotto i 100¢, il **46%** sotto i 99¢, ma anche il **25% sopra i 100,5¢** —
cioè accetta micro-perdite pur di liberare capitale. **È esattamente la nostra doppia soglia
99/100,5**, osservata in natura. Size mediana per merge: 50 share.

Nota: un singolo SPLIT da **$10.000** su «Will China invade Taiwan by end of 2026» il 13 giugno 2026.
Questo wallet non è piccolo.

### wesquezz — `0xe41c4cc0d910a6f44b1fc85c42cd3ad82039afab`

Il più veloce e il più selettivo sui montepremi. Specialista di esport.

| | |
|---|---|
| Primo trade | 29 mag 2026 · **70 giorni** |
| Fill | 1.302 · 729 BUY / 573 SELL · rapporto **1,27** |
| Reward | **$5.522** = $77,77/giorno = $4,24 per fill · rebate $141 |
| Capitale medio | **$7.724 … $19.170** · picco $13.930 (prudente) |
| Rendimento | **1,01% … 0,41% al giorno** → **$10,1 … $4,1 per $1.000/giorno** |
| Nozionale ruotato | $78.124 = 4,1× |
| Nozionale per fill | **$47,18** (Q1–Q3 $25,0–$75,0) · size 76,9 share |
| Mercati | **835** · **12 nuovi/giorno** · 69 giorni con trade su 70 (**99%**) |
| Scadenza al primo fill | **0,26 giorni** (Q1–Q3 0,19–0,60) — sei ore |
| Montepremi | mediana **$225/giorno** (Q1–Q3 $25–$906) ← il più selettivo dei quattro |
| Banda | **2,5¢** mediana (242 mercati) — la più stretta |
| Categorie | **esport 546 (65%)** · sport 217 · altro 60 |
| Ore | 17 ore ≥2% · picco h15 UTC · dorme 02–06 |
| Distanza dal mid | BUY **1,01¢** (0,5–4,0) · SELL **1,30¢** (0,5–3,9) |
| Frazione di banda | **0,40 BUY · 0,33 SELL** |
| Chiusura | aperto/scaduto 632 · **redeem 170** · vendita 33 |
| Durata ciclo | **5,0 h** (Q1–Q3 2,9–11,8) — il più corto |
| Perdite | **3,4%** — la disciplina migliore · mediana −$1,60 · peggiore −$14,41 |
| P&L di trading | **+$1.317** |
| Affollamento | 117 wallet mediani |

La ricetta è visibile: va dove il montepremi è grosso ($225/giorno mediano contro i $3 di Nopants),
su mercati che scadono entro sei ore, con banda stretta, e cicla in cinque ore. Lavora **tutti i
giorni**.

### 0xF0e02A54 — `0xf0e02a54c235b27273fdc63fef80224e1280016a`

Il caso anomalo, e va detto subito: **la caratterizzazione precedente come "venditore da split" non
regge ai dati.** Zero eventi SPLIT in 360 giorni, 2 merge, 6 redeem.

| | |
|---|---|
| Primo trade | 5 giu 2026 · **86 giorni** |
| Fill | 1.366 · **42 BUY / 1.324 SELL** · rapporto **0,032** |
| Reward | **$11.298** = **$129,87/giorno** — il più alto dei quattro · rebate $277 |
| Capitale medio | $85 … **$15.123** ← forchetta inutilizzabile, vedi sotto |
| Rendimento | 154% … **0,86% al giorno** → fino a **$8,6 per $1.000/giorno** |
| Nozionale per fill | **$14,00** (Q1–Q3 $5,10–$37,00) · size 51,4 share |
| Mercati | **876** · 13 nuovi/giorno · 79 giorni su 86 (92%) |
| Scadenza al primo fill | **59,8 giorni** (Q1–Q3 4,9–151,5) ← l'unico che va lungo |
| Montepremi | mediana **$3/giorno** (Q1–Q3 $2–$6) ← il meno selettivo |
| Banda | 4,5¢ (610 mercati) |
| Categorie | altro 234 · **politica/geo 226** · sport 169 · esport 89 · crypto/token 88 |
| Ore | **23 ore su 24** ≥2% del volume — non dorme mai |
| Distanza dal mid | BUY **1,0¢** · SELL **1,5¢** (Q1–Q3 1,0–2,2) |
| Frazione di banda | **0,22 BUY · 0,33 SELL** |
| Chiusura | **aperto/scaduto 856** · vendita 18 · redeem 2 |
| Durata ciclo | **249,8 h** (10 giorni) |
| Cicli in perdita | **70%** · mediana −$3,80 · peggiore −$9,65 |
| Affollamento | **77 wallet mediani** — cerca i mercati meno affollati |

**Il 97% delle sue vendite avviene su token mai comprati prima.** Su Polymarket si può stare dal
lato SELL senza possedere il token: l'exchange conia una serie completa dal collaterale del
venditore, che di fatto compra il lato opposto a (1−p). Ma le sue posizioni vive non tornano con
questa lettura: detiene 78 posizioni a prezzo di carico basso (0,09–0,24) su mercati di **eventi
neg-risk multi-esito** dove `/trades` non registra nessun acquisto. Il meccanismo è quasi
certamente la **conversione neg-risk**, che gli endpoint pubblici non espongono.

Conseguenza onesta: **il suo capitale non è ricostruibile e il suo rendimento non è confrontabile.**
Restano osservabili il posizionamento, i tempi e i prezzi.

**I cicli a due lati (47 mercati su 876, il 5%):** somma dei due prezzi di vendita **97,0¢**
mediana (Q1–Q3 91,4–101,0), sopra i 100¢ solo nel **32%** dei casi. Non è quindi un arbitraggio
sistematico sulla coppia. Esempi ricostruiti:

| somma | prezzi di vendita | ore al riempimento | mercato |
|---|---|---|---|
| 112,6¢ | 0,540 + 0,586 | 130 h / 942 h | Anthropic public ticker $ANTH |
| 103,3¢ | 0,323 + 0,710 | 5 h / 1.014 h | Bulgarian president |
| 99,0¢ | 0,390 + 0,600 | 0 h / 62 h | Emmys 2026 |
| 98,3¢ | 0,713 + 0,270 | 372 h / 0 h | Partido Liberal seats |
| 96,9¢ | 0,399 + 0,569 | 314 h / 0 h | Billboard #1 |
| 64,6¢ | 0,250 + 0,396 | 814 h / 0 h | Malaysian House |
| 53,0¢ | 0,120 + 0,410 | 265 h / 0 h | UK GDP growth |

**La gamba lenta è lentissima**: una parte si riempie subito, l'altra dopo 130–1.014 ore. E nei casi
sotto i 100¢ la coppia è in perdita certa alla risoluzione. Il guadagno resta il reward.

---

## La tabella dei parametri: osservato → proposto per i nostri $620

| Parametro | 0x71a5B653 | Nopants | wesquezz | 0xF0e02A54 | **Nostro oggi** | **Proposto** |
|---|---|---|---|---|---|---|
| Distanza dal mid, BUY | 0,5¢ | 1,5¢ | 1,0¢ | 1,0¢ | `OFFSET_TICKS=1` | **1 tick, ≈0,5–1,0¢** ✔ già giusto |
| Distanza dal mid, SELL | 0,5¢ | 0,75¢ | 1,3¢ | 1,5¢ | idem | **0,5–1,0¢** ✔ |
| Frazione della banda | 0,20–0,22 | 0,22–0,34 | 0,33–0,40 | 0,22–0,33 | non misurata | **quotare al 20–35% della banda dal mid** |
| Nozionale per ordine | $40 | $28 | $47 | $14 | ~$100+ | **$30–45** |
| Size in share | 91 | 60 | 77 | 51 | — | **60–90** (rispettando `rewardsMinSize`) |
| Nuovi mercati al giorno | 5 | 6 | 12 | 13 | ~0,3 | **4–6**, poi 8–10 |
| Mercati contemporanei | — | — | — | — | 4–6 | **12–18** |
| Scadenza al primo fill | 0,43 g | 0,63 g | **0,26 g** | 59,8 g | **12–24 g** | **< 24 ore** ← il cambio grosso |
| Montepremi del mercato | $62/g | $3/g | **$225/g** | $3/g | non filtrato | **≥ $25/giorno**, preferire ≥$100 |
| Banda del mercato | 4,5¢ | 4,5¢ | **2,5¢** | 4,5¢ | non filtrata | 2,5–4,5¢, indifferente |
| Affollamento | 135 | 97 | 118 | **77** | non misurato | **non è un criterio**: lavorano affollati |
| Ore operative | 16 | 16 | 17 | **23** | 24 (bot) | ✔ già giusto |
| Giorni attivi | 69% | 51% | **99%** | 92% | — | tutti |
| Durata del ciclo | 20 h | 17 h | **5 h** | 250 h | — | **chiudere entro 24 h** |
| Come si chiude | **redeem 74%** | redeem 46% | redeem 21% | scade 98% | auto-close | **lasciar risolvere**, non vendere |
| Cicli in perdita | 7,8% | 6,3% | **3,4%** | 70% | — | < 8% |
| Taglio delle perdite | 45,6 h | **0,83 h** | 10,2 h | 194 h | — | **entro 1–10 h** |
| Rotazione sul capitale | 5,8× | 4,6× | 4,1× | 2,1× | — | 4–6× |
| Merge | mai | 123 (99,66¢) | mai | 2 | **eseguibile, spento** ([nota nel v2](manuale-operativo-maker-v2.md#il-setting-consensus)) | **opzionale** |

### Il numero che conta

**Rendimento osservato: $2,4–$14,6 al giorno per ogni $1.000 di capitale impegnato.**

Applicato ai nostri $620: **$1,5–$9,0 al giorno**. Con la mediana dei quattro, **circa $4–5 al
giorno**.

Il target di $30/giorno con $620 **non è raggiungibile**: richiederebbe $48 per $1.000/giorno,
tre volte il migliore dei quattro. Il report precedente diceva il contrario, e sbagliava perché
usava `/value` come capitale.

Per $30/giorno servono, ai loro rendimenti, **fra $2.000 (al ritmo del migliore) e $12.500 (al
ritmo mediano)** di capitale impegnato.

---

## Dove i quattro divergono: gli stili fra cui scegliere

**A · Maker puro a scadenza corta** (0x71a5B653, wesquezz). Mercati che chiudono entro ore, si
lascia risolvere, il P&L di trading è irrilevante o negativo, tutto il guadagno è reward. Il più
redditizio per dollaro ($4–$15 per $1.000). Richiede molti mercati e un ricambio continuo.

**B · Maker paziente con merge** (Nopants). Scadenze più lunghe, BUY tre volte le SELL, fonde per
liberare capitale accettando micro-perdite. Il meno redditizio per dollaro ($0,6–$1,3) ma il più
stabile: 356 giorni di operatività, perdite tagliate in 50 minuti.

**C · Venditore neg-risk a scadenza lunga** (0xF0e02A54). Vende su eventi multi-esito, 876 mercati,
tiene 10 giorni, il 70% dei cicli chiude in perdita e non importa perché il reward paga. Il più alto
in assoluto ($130/giorno) ma su un meccanismo che gli endpoint pubblici non espongono: **non è
copiabile senza capirlo meglio.**

Per noi lo stile **A** è l'unico che si mappa sul motore attuale senza cambiarne la natura.

---

## I cinque numeri in cui siamo più lontani — la lista priorità

**1 · La scadenza dei mercati. 12–24 giorni contro 0,26–0,63.** È il divario più grande e spiega
tutti gli altri. Un mercato che chiude fra sei ore paga il reward, si risolve, e il capitale torna
libero lo stesso giorno. Un mercato a 20 giorni immobilizza il capitale per venti giorni allo stesso
reward giornaliero. **Loro ruotano 4–6 volte il capitale; noi zero.**

**2 · Il numero di mercati. 4–6 contemporanei contro 12–18, e 0,3 nuovi al giorno contro 5–13.**
Diretta conseguenza del punto 1: se i mercati scadono in ore, se ne aprono di nuovi ogni giorno per
forza.

**3 · La selezione sul montepremi. Non la facciamo affatto.** wesquezz sta su mercati da $225/giorno
mediani, 0x71a5B653 su $62. Con un montepremi da $3/giorno la quota che possiamo prenderci è
irrilevante qualunque cosa facciamo. **È il filtro più economico da aggiungere e probabilmente il
secondo più redditizio.**

**4 · La taglia dell'ordine. ~$100 contro $28–47.** A parità di capitale, ordini da $35 stanno su
tre volte più mercati. Il reward premia la presenza in banda su molti libri, non la profondità su
uno.

**5 · Come si chiude. Auto-close contro lasciar risolvere.** Il 74% dei cicli di 0x71a5B653 finisce
a redeem. Vendere costa spread; se il mercato scade fra ore, aspettare costa nulla. Il nostro
auto-close ha senso su orizzonti lunghi — sparisce come problema se adottiamo il punto 1.

**Quello che NON va cambiato:** la distanza dal mid (1 tick ≈ 0,5–1,0¢ è esattamente la loro), le
ore operative (24/7 è già il massimo), e il rendimento per dollaro (siamo a $4,00 per $1.000/giorno,
dentro la loro forchetta). L'affollamento non è un criterio: lavorano su mercati con 77–135 wallet
attivi e prendono lo 0,2–0,6% dei trade.

---

## Limiti di metodo — dichiarati

**1 · Il capitale è una forchetta, non un numero.** Il limite inferiore conta solo gli acquisti
tracciati; il superiore tratta ogni vendita scoperta come collaterale immobilizzato a (1−p) fino al
redeem. Il vero sta in mezzo, più vicino al limite inferiore per chi ha BUY e SELL bilanciati
(0x71a5B653, wesquezz) e indeterminato per 0xF0e02A54.

**2 · I versamenti non sono osservabili.** `/activity?type=DEPOSIT` restituisce vuoto per tutti e
quattro. La Sezione A.1 richiesta — «capitale versato» — non è ricostruibile dagli endpoint
pubblici; resta solo la stima dalla dinamica delle posizioni.

**3 · La distanza dal mid è misurata su `prices-history`, che è l'ultimo scambiato, non il
book.** Il punto più vicino al fill spesso *è* il fill (scarto mediano 15–16 s), quindi la distanza
risultava ~0 per costruzione. I numeri riportati usano il punto **almeno 120 s prima** (età mediana
~150 s), che non può essere contaminato. **La magnitudine (0,5–1,5¢) è solida; il segno no** — una
serie di ultimi-scambiati non dice da che lato del book stesse l'ordine, e infatti la quota di BUY
sotto il mid precedente (5–20%) non è interpretabile.

**4 · Il campione della Sezione B è parziale**: 489–547 fill con storico su 1.302–2.387 totali
(37–41%), scelti come i 120 token più attivi più un campione sistematico di 80 sul resto. Una
chiamata per grappolo di fill; l'endpoint rifiuta finestre oltre ~72 ore, quindi i fill sono stati
raggruppati con stacco di 4 ore.

**5 · L'affollamento è un limite superiore.** Conta i wallet distinti nei primi 500 trade del
mercato: include i taker, che non sono concorrenti sul reward.

**6 · I metadati Gamma coprono 4.229 mercati su 4.247.** Il primo giro ne trovava 544: `/markets`
filtra i mercati **chiusi** per default, e questi wallet lavorano quasi solo su mercati che nel
frattempo si sono risolti. Corretto interrogando ogni lotto due volte.

**7 · Il meccanismo di 0xF0e02A54 resta ignoto** (punto 1 della sua scheda). Le sue righe in tabella
vanno lette come comportamento osservato, non come strategia compresa.

**8 · Le categorie sono dedotte da titolo ed eventSlug** con parole chiave, non da una tassonomia
del venue: «altro» resta fra il 7% e il 27% a seconda del wallet.

**9 · Finestra 360 giorni, chiusa il 7 agosto 2026.** Nopants ha 356 giorni di storia dentro la
finestra, gli altri meno per età: 207, 86, 70. I confronti «al giorno» sono normalizzati sui giorni
di vita effettivi, non sui 360.

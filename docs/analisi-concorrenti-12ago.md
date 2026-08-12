# Chi quota contro di noi — 12 agosto 2026

**SOLA LETTURA.** Nessun ordine, nessun riavvio, nessuna modifica al codice operativo. KILL attivo,
bot FERMO, freno di prova inserito per tutta la durata dell'analisi.

Rifacibile con `node scripts/analisi-concorrenti.js --giorni 4`; dati grezzi in
`docs/analisi-concorrenti-dati.json`.

---

## 0 · Cosa è MISURATO e cosa è STIMATO — da leggere prima dei numeri

| | |
|---|---|
| ✅ **misurato** | livelli di prezzo in banda, size per livello, distanza dal mid (book reale, `mid-history`) |
| ✅ **misurato** | la nostra quota di pool con la formula del venue (`rewardScore.scoreOrder` + `qMin`) sulla scala vera |
| ✅ **misurato** | posizione del nostro prezzo di piano rispetto al miglior concorrente |
| ✅ **misurato** | wallet che hanno **eseguito** trade su ciascun mercato (`data-api/trades`, pubblico) |
| ⚠️ **parziale** | persistenza dei livelli: misurata, ma su finestre di **1,2–13,3 ore**, non su 24 |
| ❌ **non misurabile** | «quanti **ordini** distinti»: il book è aggregato per prezzo — si contano **livelli** |
| ❌ **non misurabile** | chi **quota** senza mai eseguire: i trade dicono chi si è mosso, non chi c'è nel book |

**Tre limiti strutturali, non aggirabili con questi dati:**

1. **Il book del CLOB è aggregato per livello di prezzo.** `bidSizeAtLevel` è la somma di tutti gli
   ordini a quel prezzo, di chiunque siano. Un livello da 1.366 share può essere un ordine o venti.
   Ovunque nel documento si legge «livelli», non «ordini».
2. **Il book non porta identità.** L'unica fonte con wallet sono i trade pubblici, che dicono chi ha
   **eseguito**. Un market maker i cui ordini non vengono mai colpiti — cioè il maker più bravo —
   **non compare**. I conteggi di partecipanti sono quindi un **limite inferiore**.
3. **`maker-21-eventi` non copre questi mercati.** I 41 wallet che agent42 sorveglia hanno **zero**
   eventi sugli undici mercati del piano. Quella fonte qui non serve a niente.

**Nota sul piano usato.** Sono gli undici mercati del piano calcolato alle ~13:0x. Ricalcolando lo
stesso piano alle 13:5x il board era già ruotato: **solo 5 mercati su 11 sopravvivono** (Austin,
Munich, Ben Butler, Manila, New York). È un dato di per sé, e torna al punto 2.

---

## 1 · Chi quota dentro la banda premiante

Book reale, campione più recente per ciascun mercato. Distanze in centesimi dal mid.

| mercato | livelli bid/ask | size bid/ask | dove si addensa |
|---|---|---|---|
| Paris temp. min | 1 / 2 | 52,6 / 108,4 | tutto a **0,5¢** dal mid |
| Voti 2026 | 1 / 2 | 814,5 / 1.942 | **0,5¢** (1.880 sul solo ask) |
| Milan | 2 / 2 | 1.796 / 956 | **1¢** e 2¢, il grosso a 1¢ sul bid |
| Austin | 2 / 2 | 249 / 428 | 1¢ e **2¢**, il grosso a 2¢ |
| Munich | 2 / 2 | 299 / 450 | 1¢ e 2¢ |
| Ben Butler | 4 / 4 | 219 / 222 | tick 0,1¢: scala fitta e simmetrica |
| Manila | 1 / 1 | 190 / 993 | un livello per lato, **ask 5× il bid** |
| Istanbul | 1 / 1 | 393 / 233 | un livello per lato |
| Houston | 2 / 2 | 332 / 179 | 1¢ e 2¢ |
| Cape Town | 2 / 2 | 497 / 147 | 1¢ e 2¢ |
| New York temp. min | 1 / 2 | 108 / 113 | 0,5¢ e 1,5¢ |

**La forma ricorrente: pochissimi livelli, tutti attaccati al mid.** Otto mercati su undici hanno
**uno o due livelli per lato**, e la liquidità sta a **0,5–2¢** dal mid. Non c'è una scala profonda:
c'è un muro sottile vicino al mid e poi il vuoto fino al bordo della banda (4,5¢). L'unico mercato con
una scala vera è Ben Butler, che ha tick 0,1¢ — dieci volte più fine — e infatti 4 livelli per lato.

---

## 2 · Quanto restano vivi — **la risposta onesta è: non lo so ancora**

È il dato che interessava di più, ed è quello che i dati **non permettono di stabilire con onestà**.

**Cosa ho misurato.** La persistenza di un *livello di prezzo* dentro la banda: quanto a lungo un
prezzo resta occupato prima di svuotarsi.

| mercato | persistenza mediana | troncate a fine finestra | finestra osservata | cadenza |
|---|---|---|---|---|
| Paris | 0,04 h | 3 | 15,7 h | 41 min |
| Voti 2026 | 0,15 h | 3 | 13,3 h | 1,3 min |
| Milan | 0,17 h | 4 | 10,3 h | 2,0 min |
| Austin | 0,23 h | 4 | 10,3 h | 2,0 min |
| Munich | 0,10 h | 4 | 5,3 h | 1,8 min |
| Ben Butler | 0,19 h | 7 | 71,0 h | 22,4 min |
| Manila | **1,73 h** | 2 | 1,9 h | 1,3 min |
| Istanbul | 0,02 h | 2 | 1,7 h | 1,3 min |
| Houston | 0,06 h | 4 | 1,7 h | 1,3 min |
| Cape Town | 0,02 h | 4 | 1,2 h | 1,3 min |
| New York | n/d | 3 | 1,2 h | 1,3 min |

**Perché questi numeri NON rispondono alla domanda «quante ore al giorno»:**

- **La persistenza di un prezzo non è la vita di un ordine.** Un prezzo occupato per sei ore può
  essere lo stesso ordine o dodici che si danno il cambio. È un **limite superiore**.
- **Le finestre sono troppo corte.** Sette mercati su undici hanno **meno di due ore** di storico,
  perché agent34 li sottoscrive solo quando entrano nel board/piano: della loro vita precedente non
  abbiamo niente. Una mediana di 0,02 h su una finestra di 1,2 h non è una misura, è un artefatto.
- **La cadenza è disomogenea**: 1,3 min sui mercati sottoscritti, **22–41 min** su Paris e Ben Butler.
  A 41 minuti di cadenza un ordine che vive mezz'ora è invisibile.
- **Il confronto con la nostra permanenza (2,28 h su 24 l'8 agosto) non è possibile**: il nostro dato
  è su una giornata intera, questi sono su frazioni di giornata.

**Quanto servirebbe per una stima onesta.** Servono, per ciascun mercato, **almeno 3 giorni di
sottoscrizione continua a cadenza ≤ 2 minuti dalla nascita del mercato**. Oggi non è possibile per
costruzione: i mercati meteo vivono 24–48 h e agent34 li sottoscrive tardi. Le due strade sono
(a) sottoscrivere i mercati candidati **appena compaiono su Gamma** invece che quando entrano nel
piano, oppure (b) fare la misura su mercati a vita lunga (Ben Butler-like), accettando che siano un
campione diverso. **Prima di allora, qualunque numero «ore al giorno» sarebbe inventato.**

---

## 3 · Dove ci mettiamo rispetto a loro

| mercato | nostro bid/ask | miglior loro bid/ask | posizione | «mai primo» ci ferma? |
|---|---|---|---|---|
| Paris | 0,40 / 0,43 | 0,38 / 0,39 | **bid davanti**, ask dietro | — |
| Voti 2026 | 0,75 / 0,77 | 0,75 / 0,76 | bid pari, ask dietro | — |
| Milan | 0,50 / 0,52 | 0,49 / 0,51 | **bid davanti**, ask dietro | — |
| Austin | 0,60 / 0,62 | 0,59 / 0,61 | **bid davanti**, ask dietro | — |
| Munich | 0,55 / 0,57 | 0,55 / 0,57 | pari su entrambi | — |
| Ben Butler | 0,520 / 0,522 | 0,51 / 0,53 | **davanti su entrambi** | — |
| Manila | 0,43 / 0,45 | 0,41 / 0,44 | **bid davanti**, ask dietro | **sì, bid+ask** |
| Istanbul | 0,44 / 0,46 | 0,44 / 0,48 | bid pari, **ask davanti** | **sì, bid+ask** |
| Houston | 0,43 / 0,45 | 0,46 / 0,48 | bid dietro, **ask davanti** | — |
| Cape Town | 0,40 / 0,43 | 0,41 / 0,43 | bid dietro, ask pari | — |
| New York | 0,39 / 0,41 | 0,39 / 0,40 | bid pari, ask dietro | — |

**Il risultato che non mi aspettavo: saremmo DAVANTI, non dietro.** Su **6 mercati su 11** il nostro
prezzo di piano batte il miglior concorrente su almeno un lato; su Ben Butler su entrambi. Su nessun
mercato siamo dietro su entrambi i lati.

**«Mai primo» ci farebbe rinunciare su 2 mercati su 11** (Manila e Istanbul), e su entrambi i lati:
lì un tick dietro il migliore cade **fuori dalla banda premiante**, quindi non si quota affatto.

---

## 4 · Quanto pesano — e dove siamo diluiti

Quota calcolata con la formula del venue (`scoreOrder` + `qMin`) sulla scala reale, con la nostra size
di piano contro la profondità in banda osservata.

| mercato | pool/g | **nostra quota** | nostro lordo/g | capitale | resa/g |
|---|---|---|---|---|---|
| Istanbul | $48 | **86,0 %** | $41,28 | $52 | **79,4 %** |
| Ben Butler | $59 | 50,4 % | $29,76 | $65 | 45,8 % |
| Austin | $58 | 50,1 % | $29,07 | $65 | 44,7 % |
| Munich | $57 | 50,2 % | $28,63 | $65 | 44,0 % |
| Houston | $55 | 38,8 % | $21,36 | $65 | 32,9 % |
| Manila | $49 | 37,5 % | $18,39 | $65 | 28,3 % |
| Paris | $42 | 41,0 % | $17,22 | $65 | 26,5 % |
| New York | $43 | 19,9 % | $8,57 | $65 | 13,2 % |
| Cape Town | $47 | 7,9 % | $3,72 | $26 | 14,3 % |
| Milan | $56 | 14,2 % | $7,95 | $65 | 12,2 % |
| **Voti 2026** | $136 | **2,6 %** | **$3,59** | **$65** | **5,5 %** |

**Totale: $209,54/g lordi su $663 = 31,6 %/giorno.** È il **lordo modellato**, non l'incassato — e la
diagnosi del 465 % dice che il modello sovrastima. Va letto come ordinamento fra mercati, non come
previsione di cassa.

**Dove siamo diluiti al punto che non vale il capitale:**

- **Voti 2026** — il pool più ricco ($136/g, il doppio degli altri) e la nostra quota più bassa
  (**2,6 %**). C'è un muro di **1.880 share sull'ask a 0,5¢ dal mid**: il pool grande ha attirato
  liquidità molto più di quanto noi possiamo aggiungerne. **$65 impegnati per $3,59/g.**
- **Milan** — 1.796 share sul bid, quota 14,2 %, resa 12,2 %.
- **Cape Town** — quota 7,9 %; qui però il capitale è già ridotto a $26 dalla scala di profondità.

**La regola che ne esce: il montepremi alto è un'esca.** I tre mercati con la resa peggiore sono fra i
più ricchi; i tre migliori (Istanbul, Ben Butler, Austin) hanno pool medi e book sottili.

---

## 5 · Chi sono — e quanti fanno market making vero

### Il filtro, dichiarato

Sui trade osservati, un wallet conta come **market maker vero** su un mercato se valgono **tutti e
tre**:

1. **presenza a due lati** — compare su entrambi i token del mercato binario, oppure sia in BUY sia
   in SELL;
2. **size comparabili** — il rapporto fra lato piccolo e lato grande è **≥ 0,33**. Sotto quella
   soglia una gamba è un accessorio dell'altra, non una quota;
3. **chiude l'esposizione** — ha almeno una vendita, invece di solo accumulare.

Chi non passa tutti e tre è **direzionale** ed è escluso. La soglia 0,33 è una scelta mia: è il punto
in cui un lato è ancora una quota e non un residuo. Cambiandola cambiano i numeri, quindi è scritta
qui e non nel codice.

**Limite del filtro**: si applica a chi ha **eseguito**. Un MM che quota e non viene mai colpito non
è classificabile, e non compare in nessuna delle due colonne.

### I due numeri per mercato

| mercato | trade osservati | **wallet totali** | **MM veri** | % MM |
|---|---|---|---|---|
| Voti 2026 | 148 | 79 | **10** | 13 % |
| Milan | 125 | 72 | 4 | 6 % |
| Munich | 107 | 68 | 5 | 7 % |
| Ben Butler | 160 | 62 | 6 | 10 % |
| Istanbul | 105 | 62 | 1 | 2 % |
| Manila | 75 | 52 | 2 | 4 % |
| Cape Town | 81 | 50 | 2 | 4 % |
| Houston | 47 | 33 | 0 | 0 % |
| Austin | 36 | 28 | 0 | 0 % |
| Paris | 40 | 20 | 2 | 10 % |
| New York | 38 | 14 | 3 | 21 % |
| **totale presenze** | 962 | **540** | **35** | **6 %** |

**Sei per cento.** Su 540 wallet-presenze osservate, **35 fanno market making a due lati con size
comparabili e chiudono**. Su **due mercati (Houston, Austin) non ce n'è nemmeno uno**: tutta l'attività
è direzionale.

**Conferma strutturale dal book**, indipendente dai trade: la banda è occupata su entrambi i lati nel
**82–100 %** dei campioni, ma il rapporto mediano fra le size dei due lati va da **0,80** (Ben Butler,
simmetrico) a **0,019** (Manila, un lato 50× l'altro). Un book così sbilanciato non è market making.

### Affrontiamo sempre gli stessi?

**No, e non di poco: 188 wallet distinti, di cui solo 42 su più di un nostro mercato.**

| wallet | nome | nostri mercati | MM in | volume |
|---|---|---|---|---|
| `0xe40aaa5c…` | Mysaria | **7 / 11** | 0 | 536 |
| `0xf7aa193b…` | IngressDefender | **7 / 11** | 2 | 481 |
| `0x03805a13…` | donthackme | 5 | 0 | 667 |
| `0x39012016…` | friendlyreward | 5 | 0 | 280 |
| `0xb0c85813…` | **-.liquidity.farm** | 4 | 0 | 329 |
| `0xae7a8109…` | **rewardcleaner** | 4 | 2 | 255 |
| `0x94180983…` | — | 3 | 0 | 448 |
| `0x29efb149…` | ImSweating | 3 | **3** | 131 |

I nomi parlano: `-.liquidity.farm`, `rewardcleaner`, `friendlyreward` sono **reward farmer**, e i due
più presenti (Mysaria, 7 mercati su 11) **non passano il filtro MM su nessuno**. L'unico ricorrente
che fa market making ovunque compare è `ImSweating`, con volumi piccoli (131).

---

## 6 · Cosa non è stato misurato, e perché

- **Ordini distinti**: il book è aggregato. Non aggirabile senza un feed order-by-order.
- **Chi quota senza eseguire**: invisibile ai trade. È probabilmente la parte più interessante della
  concorrenza, e resta fuori.
- **Ore al giorno di permanenza**: vedi §2. Servono ≥3 giorni di sottoscrizione continua per mercato.
- **Se i ricorrenti chiudono o portano a risoluzione**: `orePrimaDellaRisoluzione` esiste solo in
  `maker-21-eventi`, che su questi mercati è vuoto. Il criterio 3 del filtro usa quindi «ha almeno una
  vendita», che è più debole.
- **Il pool per mercato** viene dal board (`dailyPool`), non dal piano: le righe del piano non lo
  portavano.

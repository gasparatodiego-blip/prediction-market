# Il premio di oggi: corti o lunghi, e in quali ore — 23 agosto 2026

**Perimetro: sola lettura.** Nessun ordine, nessun riavvio, nessuna configurazione toccata.
Misura chiusa alle **15:44:19Z** del 23/08 (giornata in corso: mancano 8 ore).
Script: `scripts/ricerca/premio-per-fascia-23-agosto.js` · dati: `data/ricerca/premio-per-fascia-23-agosto.json`

---

## 0 · LA RISPOSTA IN CINQUE RIGHE

1. **La stima per mercato NON è affidabile, e non è nemmeno *misurata*: è ricostruita da me.** Il bot
   non scrive da nessuna parte quanto ha maturato un singolo mercato; e la stima aggregata che scrive
   ha oggi il **40,7% di copertura** ed è prezzata a una posa che il bot **non tiene** (S = 0,5625
   contro S = 0,111-0,207 reali).
2. **Premio per dollaro-ora, alla posa vera**: **CORTI $0,003368** · **LUNGHI $0,000884** — corti
   3,81×. Con la stima *del bot* (posa fittizia) il divario si riduce a 2,45×: l'errore di posa
   **favorisce i lunghi**.
3. **I corti hanno vinto dalle 08Z alle 13Z**, sei ore consecutive, con rapporti da 1,41× (08Z) a
   **25,6× (13Z)**. Nelle altre dieci ore misurate hanno vinto i lunghi.
4. **Netto per fascia: non è chiudibile a due numeri, e va detto.** Premio ricostruito $2,13 (corti) e
   $5,68 (lunghi); il P&L di trading è misurabile **solo a livello di portafoglio** — **−$7,65** sulla
   giornata — perché oggi ci sono 12 fill tutti BUY e **zero SELL riempiti**: non esiste una coppia
   entrata/uscita da attribuire a una fascia.
5. **Il campione NON basta, e la conclusione si rovescia togliendo un mercato solo.** I corti attivi
   sono 7 ma valgono **14,4 ore-mercato** in tutto, e **l'81,4% del loro premio viene da UN mercato
   con 1,7 ore a libro** («US imposes new sanctions on Iran by Monday?»). **Tolto quello, i corti
   NON sono più avanti**: $0,000717 contro $0,000884 dei lunghi.

---

## 1 · LA BASE — come il bot calcola il premio maturato, e con quale copertura

### La formula, e da dove viene ogni pezzo

```
estUsdPerDay(mercato) = poolDay × share
share = Qu / (Qu + Qconcorrenti)          ← lib/rewardScore.js:285 quadraticUserShare
Qu    = qMin(S·size, S·size, mid)          con  S(v,s) = ((v − s)/v)²   ← formula pubblicata dal venue
v     = rewardsMaxSpread, la SEMIAMPIEZZA  ← lib/banda-premiante.js (SSOT dal 13 agosto)
size  = sizeAllaDistanza(capitale, mid, s) ← costo coppia 1 − 2s/100
```

Catena delle sorgenti, tutte importate e non ricopiate:

| pezzo | file:riga | cosa |
|---|---|---|
| punteggio del venue | `lib/rewardScore.js:59` `scoreOrder` | `((v−s)/v)²` |
| quota | `lib/rewardScore.js:285` `quadraticUserShare` | `Qu/(Qu+Qc)` |
| `refShare` | `lib/rewards-normalize.js:137` | quota di un maker da $1.000 |
| $/giorno dell'operatore | `lib/reward-operator-estimate.js:205` `estimateAtCapital` | `poolDay × refShare` riscalata al capitale vero |
| somma per mercato | `lib/maker/operator-board.js:493-512` `buildSummary` | `estPerMarket` + `estGrossUsdPerDay` |
| integrale della giornata | `lib/maker/stima-integrata.js` | `Σ tasso × durata` |

### ⚠ PRIMO PROBLEMA: la scomposizione per mercato NON ESISTE SU DISCO

`buildSummary` **calcola** `estPerMarket` a ogni campione, ma `agent40-manual-reprice.js:2515` passa a
`stima-integrata.registraCampione` **soltanto** `tassoUsdPerDay` e `capitaleInBandaUsd`. In
`data/stima-campioni.json` ogni riga è `{t, r, c}`: nessun mercato. Anche l'osservatore non aiuta —
`ordiniPerMercato` è `null` in **920 campioni su 920** oggi, con motivo scritto: *«marketId redatto
nelle righe di elenco del giornale: non ricostruibile»*.

**Quindi la domanda «quanto ha reso questo mercato in questa ora» non è rispondibile dallo stato
salvato.** Tutto ciò che segue è una **RICOSTRUZIONE**: capitale a libro per mercato (misurato, 1
campione/minuto da `data/osservazione-24h.jsonl`) × tasso che i moduli condivisi assegnano a quel
mercato **col board CORRENTE**, perché agent24 riscrive `data/liquidity-rewards.json` e non lo
versiona. Assunzione dichiarata: punteggio e concorrenza stazionari nella giornata.

### ⚠ SECONDO PROBLEMA: la stima è prezzata a una posa che il bot non tiene

`refShare` è scorata a **`d = v/4`** (`rewards-normalize.js:137`), cioè **S = 0,5625**. Il bot invece
si posa a 3,0-3,5¢ dal mid, che su `v = 4,5¢` vale **S = 0,1111** e su `v = 5,5¢` vale **S = 0,2066**.

Il conto è verificato, non argomentato: ho ricalcolato la stessa giornata con la **stessa funzione**
`quadraticUserShare`, cambiando **solo** l'argomento `d`.

| variante | posa | premio corti | premio lunghi |
|---|---|---|---|
| **A** — `estimateAtCapital`, cioè il numero del bot | `d = v/4` (S 0,5625) | $3,33 | $13,82 |
| **A′** — stessa funzione di B, ma a `d = v/4` | `d = v/4` | $3,35 | $13,82 |
| **B** — stessa funzione, alla posa VERA | 3,0 / 3,5¢ | **$2,13** | **$5,68** |

**A′ ≡ A al centesimo**: è la prova che `estimateAtCapital` non è un secondo modello, è
`quadraticUserShare` a `v/4`. L'unica differenza fra A e B è la distanza.
**La sovrastima misurata è 1,57× sui corti e 2,43× sui lunghi**: usare la stima grezza fa sembrare i
lunghi **1,55× migliori di quanto siano**, rispetto ai corti.

### La copertura, dichiarata

| | |
|---|---|
| campioni della stima aggregata oggi | **67** su ~188 attesi a passo 5 min |
| **copertura dichiarata da `stima-integrata`** | **40,65 %** — la cifra della giornata è una **sottostima nota** |
| ore UTC con **zero** campioni | **03Z, 08Z** (16Z-23Z non sono ancora passate) |
| ore con 1-3 campioni soli | 02Z, 04Z, 05Z, 09Z, 10Z, 11Z, 12Z, 13Z, 14Z, 15Z |
| copertura dell'osservatore (il libro per mercato) | **1,00** su tutte le ore tranne 15Z (0,73, ora in corso) |

È §5.2 p.63 che morde oggi: il `catch { }` muto di `campionaStima` non distingue «eccezione» da
«tasso non misurabile», e il risultato è una giornata coperta al 40,7%.

---

## 2 · LA VERIFICA — la somma torna? No, e il consuntivo di oggi non esiste ancora

**Il consuntivo del venue per oggi NON è leggibile**, e non per un guasto: interrogato in sola lettura
(`lib/maker/reward-reale.leggiRewardReale`, registro attività pubblico) risponde

> `disponibile:false · «la finestra di pagamento di 2026-08-23 non è ancora chiusa (si chiude
> 2026-08-24T06:00:00.000Z): nessun pagamento visibile non è ancora uno zero»`

**E anche quando arriverà non servirà a validare l'attribuzione per mercato**: la lettura di ieri
(22/08) è arrivata **attribuita**, `$3,2001`, un bonifico solo alle 00:00:04Z del 23/08 — con
**`perMercato: 0`**. Il venue paga un aggregato: **non esiste un termine di paragone per mercato**,
oggi né mai.

Restano due confronti veri.

**(a) La mia ricostruzione contro la misura del bot, sugli stessi intervalli.** Ristretta alle finestre
che il campionatore aggregato copre davvero: ricostruzione A **$6,36** contro **$4,28** misurati —
**+48,7 %**.

> **⇒ La somma NON torna entro il 10%. Dichiarato: l'attribuzione per mercato è INDICATIVA, non
> misurata.** Lo scarto è l'assunzione di stazionarietà del board (uso la fotografia delle 15:44 per
> tutta la giornata) più il fatto che il campionatore **non registra affatto** quando anche un solo
> mercato non è scorabile.

**(b) La stima del bot contro il pagato, sulle giornate chiuse** (`data/confronto-reward.json`):

| giorno | integrata | copertura | pagato dal venue | rapporto |
|---|---|---|---|---|
| 2026-08-16 | $14,2971 | 99,7% | $2,183 | **6,55×** |
| 2026-08-18 | $1,9192 | 98,0% | $0 | — |
| 2026-08-19 | $7,2844 | 95,1% | $0 | — |
| 2026-08-20 | $13,4275 | 95,4% | $4,9455 | **2,72×** |
| 2026-08-21 | $1,3666 | 89,6% | $0 | — |
| 2026-08-22 | $7,5288 | 83,6% | $3,2001 | **2,35×** |

Il verdetto del modulo di confronto è `dati-insufficienti` (2 giornate confrontabili su 5 richieste).
Le tre giornate confrontabili danno 2,35-6,55×, coerenti con l'errore di posa del §1.

**Controlli di sanità superati:**

| controllo | esito |
|---|---|
| libro ricostruito dal giornale vs elenco AUTOREVOLE del venue | 936 campioni confrontabili, **85,6% concordi** |
| nozionale dell'osservatore vs `committedInBandUsd` di `buildSummary` | scarto mediano **0,00%**, 71% entro il 5% ⇒ il capitale che prezzo è davvero quello in banda |
| tetto di profondità in banda (`depthLimited`) | **0 su 6.246 valutazioni** — non morde mai, non è lui a muovere i numeri |

---

## 3 · LA TABELLA ORARIA

Premio = **variante B** (posa vera). `$/$·h` = premio ÷ capitale-ore della fascia in quell'ora.

| ora | CORTI premio | merc. | ordini | nozion. medio | **$/$·h** | LUNGHI premio | merc. | ordini | nozion. medio | **$/$·h** | vince |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 00Z | 0.0229 | 3 | 1.80 | 37.99 | 0.000722 | 0.1661 | 5 | 1.81 | 49.56 | 0.001322 | lunghi |
| 01Z | 0.0239 | 2 | 1.58 | 44.25 | 0.000483 | 0.4219 | 5 | 2.00 | 53.42 | 0.001924 | lunghi |
| 02Z | 0.0000 | 1 | 1.00 | 38.83 | 0.000000 | 0.4146 | 9 | 1.97 | 54.04 | 0.001034 | lunghi |
| 03Z | 0.0000 | 0 | 0.00 | 0.00 | 0.000000 | 0.4815 | 8 | 1.93 | 52.31 | 0.001393 | lunghi |
| 04Z | 0.0017 | 1 | 2.00 | 47.43 | 0.001043 | 0.3692 | 7 | 1.69 | 44.05 | 0.001478 | lunghi |
| 05Z | 0.0495 | 1 | 2.00 | 47.43 | 0.001043 | 0.4270 | 6 | 1.86 | 51.32 | 0.001593 | lunghi |
| 06Z | 0.0438 | 1 | 2.00 | 47.31 | 0.000924 | 0.4719 | 6 | 1.96 | 54.19 | 0.001652 | lunghi |
| 07Z | 0.0495 | 1 | 2.00 | 47.43 | 0.001043 | 0.5182 | 7 | 1.95 | 52.37 | 0.001594 | lunghi |
| 08Z | 0.0495 | 1 | 2.00 | 47.43 | 0.001043 | 0.2793 | 12 | 1.92 | 51.72 | 0.000741 | **CORTI** |
| 09Z | 0.0479 | 1 | 1.98 | 46.97 | 0.001036 | 0.2560 | 10 | 1.99 | 53.19 | 0.000697 | **CORTI** |
| 10Z | 0.6270 | 2 | 2.23 | 58.21 | 0.007337 | 0.2965 | 12 | 1.99 | 52.97 | 0.000795 | **CORTI** |
| 11Z | 0.3910 | 3 | 1.74 | 42.93 | 0.005200 | 0.3119 | 14 | 1.94 | 52.05 | 0.000595 | **CORTI** |
| 12Z | 0.4023 | 4 | 1.79 | 40.16 | 0.004963 | 0.3872 | 14 | 1.93 | 51.44 | 0.000595 | **CORTI** |
| 13Z | 0.4161 | 3 | 2.00 | 41.81 | 0.011698 | 0.3100 | 16 | 1.95 | 50.95 | 0.000457 | **CORTI** |
| 14Z | 0.0000 | 1 | 1.29 | 22.41 | 0.000000 | 0.3142 | 16 | 1.96 | 51.49 | 0.000445 | lunghi |
| 15Z | 0.0000 | 1 | 1.95 | 31.07 | 0.000000 | 0.2500 | 16 | 1.94 | 51.15 | 0.000479 | lunghi |
### Le ore in cui i corti hanno reso più dei lunghi a parità di capitale impiegato

**08Z, 09Z, 10Z, 11Z, 12Z, 13Z** — sei ore consecutive.

| ora | corti $/$·h | lunghi $/$·h | rapporto |
|---|---|---|---|
| 08Z | 0,001043 | 0,000741 | 1,41× |
| 09Z | 0,001036 | 0,000697 | 1,49× |
| 10Z | 0,007337 | 0,000795 | **9,23×** |
| 11Z | 0,005200 | 0,000595 | **8,74×** |
| 12Z | 0,004963 | 0,000595 | **8,35×** |
| 13Z | 0,011698 | 0,000457 | **25,60×** |

⚠ **Le quattro ore che contano (10Z-13Z) sono un mercato solo**: «US imposes new sanctions on Iran by
Monday?» entra alle ~10Z con pool $50/giorno e **$49 di profondità premiante altrui** — cioè il nostro
mezzo capitale è quasi tutto il libro. Non è una proprietà della fascia corta: è un libro vuoto.

⚠ **A 14Z e 15Z i corti tornano a ZERO** (nozionale medio $22-31, sotto il minimo del venue).

---

## 4 · IL PREMIO PER DOLLARO — il numero che conta

| | CORTI | LUNGHI | rapporto |
|---|---|---|---|
| premio ricostruito, posa vera (B) | **$2,1251** | **$5,6754** | |
| capitale-ore impiegato | 630,97 $·h | 6.419,31 $·h | 1 : 10,2 |
| **$ di premio per $ impiegato per ora** | **$0,003368** | **$0,000884** | **3,81×** |
| lo stesso, con la stima *del bot* (A) | $0,005275 | $0,002152 | 2,45× |
| nozionale medio per mercato | $43,93 | $51,67 | |
| mercati attivi | 7 | 35 | |

### ⚠ IL FATTO PIÙ GRAVE DELLA GIORNATA: metà del capitale dei corti ha reso ZERO PER REGOLA DEL VENUE

| | CORTI | LUNGHI |
|---|---|---|
| capitale-ore **sotto `min_incentive_size`** | **320,01 $·h** | 84,10 $·h |
| **frazione** | **50,7 %** | **1,3 %** |
| capitale-ore su mercati non scorabili (fuori dal board) | 96,28 $·h (15,3%) | 1.405,35 $·h (21,9%) |

Sotto `min_incentive_size` il venue **non assegna punteggio**: il reward non è più basso, è **zero**.
Il meccanismo è aritmetico e verificato sul mercato corto dominante (`0x316e494b35`, minSize 50): a
`$45` di nozionale `sharePerLato` dà 47,9 share ⇒ quota **0**; la soglia si supera a **$49**. Il
nozionale medio dei corti oggi è **$43,93**. Il mercato con più ore a libro fra i corti (Elon Musk
40-64 tweets, 8,21 h su 14,4 totali) ha **294,4 delle sue 375,7 ore-capitale — il 78% — sotto il
minimo**.

---

## 5 · IL COSTO

| | CORTI | LUNGHI |
|---|---|---|
| **gambe riempite** (fill veri, `data/safety-fills.jsonl`) | **9** — $122,35 di nozionale | **3** — $36,53 |
| **coppie chiuse / merge on-chain eseguiti** | **5** (131,04 share ⇒ $131,04 di collaterale liquido) | **0** |
| merge on-chain falliti | 1 (relayer HTTP 400) | 0 |
| mercati con gamba **scoperta oltre 4 h** (`scoperto-oltre-soglia-grave`) | **0** | **2** |
| posizioni **abbandonate** (R6) | 1 — perdita $1,09 (carico $1,82, residuo $0,73) | 1 — perdita $2,19 (carico $3,65, residuo $1,46) |
| **premio ricostruito (B)** | **$2,13** | **$5,68** |
| **P&L di trading** | **non misurabile per fascia** | **non misurabile per fascia** |

**Perché il P&L di trading non si scompone, e non è una rinuncia comoda.** Oggi ci sono **12 fill,
tutti BUY, e zero SELL riempiti**: nessun ciclo entrata→uscita si è chiuso vendendo, quindi non
esiste una coppia di prezzi da attribuire a una fascia. Ciò che si chiude — i 5 merge — restituisce
$1/share, ma il costo della coppia sta in parte in gambe comprate **ieri**, e il ledger non conserva
il carico per fascia.

**Ciò che è misurato, a livello di PORTAFOGLIO** (`data/osservatore/campioni-2026-08-23.jsonl`, il
premio di oggi non è ancora accreditato e non ci sono depositi, quindi il delta È il P&L di trading):

```
00:00:18Z   totale $1.496,6121   (saldo 1.496,61 · posizioni 0,00)
15:44:18Z   totale $1.488,9653   (saldo 1.457,97 · posizioni 30,99)
                    ─────────
delta della giornata            −$7,6468
```

> **⇒ Il netto per fascia sono DUE NUMERI SOLI SE SI ACCETTA CHE IL COSTO NON SIA ATTRIBUIBILE.**
> Premio ricostruito: corti **+$2,13**, lunghi **+$5,68** (totale $7,78). Costo di trading: **−$7,65
> di portafoglio, indiviso**. Il netto di giornata è quindi **circa +$0,13 complessivi** — e i corti,
> che sono l'8,9% del capitale-ore, hanno preso il **75% dei fill**.

---

## 6 · IL CAMPIONE — non basta, e la conclusione si rovescia

**7 mercati corti attivi oggi, per 14,36 ore-mercato in tutto** (contro 35 lunghi per 123,98 ore):

| ore a libro | scorabile | mercato |
|---|---|---|
| 8,21 h | sì | Will Elon Musk post 40-64 tweets from August 22 to August 29? |
| 1,72 h | **sì** | **US imposes new sanctions on Iran by Monday?** |
| 1,72 h | no (fuori board) | Will MrBeast's next video get between 37 and 39 million views? |
| 1,65 h | sì | Will Elon Musk post <40 tweets from August 22 to August 29? |
| 0,58 h | no (fuori board) | Will Elon Musk post 65-89 tweets from August 22 to August 29? |
| 0,45 h | no (fuori board) | Will MrBeast's next video get between 25 and 30 million views? |
| 0,03 h | sì | Will 25-49 ships transit the Strait of Hormuz between August 22-29? |

**Quattro dei sette hanno prodotto esattamente $0** (tre fuori dal board, uno sotto il minimo).

### La prova che il campione non regge

| | premio B | capitale-ore | $/$·h |
|---|---|---|---|
| CORTI, tutti e 7 | $2,1251 | 630,97 | **0,003368** |
| di cui il solo mercato Iran | $1,7291 (**81,4 %**) | 78,4 | 0,022063 |
| **CORTI senza quel mercato** | $0,3960 | 552,6 | **0,000717** |
| LUNGHI | $5,6754 | 6.419,31 | **0,000884** |

> **⇒ Togliendo UN mercato con 1,7 ore a libro, i corti passano da 3,81× meglio a 1,23× PEGGIO dei
> lunghi.** Una conclusione che si rovescia rimuovendo un'osservazione non è una conclusione.
> **Non si estrapola da questo campione.**

La regola di soglia della diagnosi (200 osservazioni per fascia) non è nemmeno avvicinata: le
osservazioni utili sono le ore-mercato scorabili, **11,6 per i corti**.

---

## 7 · COSA NON SONO RIUSCITO A MISURARE, E PERCHÉ

| domanda | perché resta senza risposta |
|---|---|
| premio **davvero** maturato per mercato | non esiste su disco: `agent40:2515` non passa `perMercato` a `registraCampione`, e il consuntivo del venue è un bonifico aggregato (`perMercato: 0` anche il 22/08) |
| premio per mercato **per ora** dal board dell'epoca | `data/liquidity-rewards.json` viene **riscritto** ogni 15 min e non versionato: non esiste storico di `poolDay`, `competitorQ` e `mid`. Uso la fotografia delle 15:44 per tutta la giornata |
| il premio delle **8 ore mancanti** (16Z-23Z) | la giornata è in corso |
| la posa **osservata** ordine per ordine | il giornale scrive la distanza solo nel ramo `inseguimento-soppresso` (5.168 righe, 12 mercati), che è per costruzione il sottoinsieme in cui il prezzo è deciso da «mai primo sul libro» e non dal bersaglio: campione **distorto**. Uso il bersaglio configurato, con le finestre dei riavvii lette dal giornale |
| il tasso dei mercati **fuori dal board** | 96 $·h dei corti (15,3%) e 1.405 $·h dei lunghi (21,9%) sono su mercati che il board corrente non elenca: `rewardScore` è `null`, e non si inventa. Sono contati fra il capitale impiegato e **non** fra il premio ⇒ i $/$·h di entrambe le fasce sono un **limite inferiore** |
| P&L di trading **per fascia** | 12 fill tutti BUY, 0 SELL riempiti: nessun ciclo chiuso da attribuire |
| costo di adverse selection per fascia | i 9 fill dei corti sono posizioni ancora aperte o fuse: il costo vero si vedrà alla chiusura |

---

## 8 · DIFETTI NUOVI TROVATI (non corretti — questa è una diagnosi)

**D-a · `CLAUDE.md` §5.2 p.31-bis e p.64 dicono l'OPPOSTO di ciò che è in servizio.**
Letto da `/proc/<pid>/environ` dei processi vivi alle 15:00Z: agent40 e agent41 hanno
`MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V=0.6666666666666666` ⇒ **lunghi a 3,0¢**, e agent41 ha
`MAKER_DISTANZA_CORTI_CENTS=3.5` ⇒ **corti a 3,5¢**. Il commit `3e74081` (08:21) aveva portato i
lunghi a 3,5¢, e `44e0a45` (08:46) **lo ha rovesciato**. §5.2 p.31-bis descrive ancora lo stato di
`3e74081`. Chi legge il CLAUDE.md oggi crede che i lunghi stiano più lontani dei corti: è il
contrario.

**D-b · D7 in `agents/ecosystem.config.js:645` vs `:676`.** Il commento dice *«I CORTI si quotano a
3,0¢ dal mid»*; la riga 676 imposta `MAKER_DISTANZA_CORTI_CENTS: '3.5'`. Il commento è ciò che si
legge, il codice ciò che accade.

**D-c · `refShare` e `levels[]` sono scorati a DUE POSE DIVERSE, e il commento dichiara il contrario.**
`lib/rewards-normalize.js:137` scora `refShare` a `d = v/4` ⇒ **S = 0,5625**; `lib/rewardScore.js:225`
(`estimateCapitalLevelRange`, che produce `levels[]`, cioè la classifica su cui la selezione ordina i
mercati, §4.13) scora a `d = v/2` ⇒ **S = 0,25**. Fattore **2,25×** fra i due, sullo stesso concetto.
Il commento a `rewards-normalize.js:135-136` — *«scoreOrder's internal half-band is v/2, and its
typical distance is (v/2)/2 = v/4 … consistent with the levels[]»* — descrive la lettura **dimezzata**
di `v`, **abolita il 13 agosto** da `lib/banda-premiante` (dove `raggioBandaCents(x) === x`). Stessa
cosa in `lib/reward-operator-estimate.js`, che dichiara `ASSUMED_PLACEMENT_SCORE = 0.25` mentre la
posa che produce davvero il suo numero vale 0,5625. È il reperto **D1 + D7** insieme, sul numero che
il pannello mostra come titolo e che ordina la selezione.
**Effetto misurato oggi: la stima sovrastima 1,57× i corti e 2,43× i lunghi**, cioè sbaglia il
CONFRONTO fra le due fasce di 1,55×.

**D-d · La stima non è scomponibile per mercato, e non per mancanza del dato ma per un campo non
passato.** `buildSummary` calcola `estPerMarket` a ogni campione; `agents/agent40-manual-reprice.js:2515`
passa a `stima-integrata.registraCampione` solo `tassoUsdPerDay` e `capitaleInBandaUsd`, e
`registraCampione` non ha nemmeno un parametro per riceverlo. Costo: questa domanda — «da dove viene
il premio» — non è rispondibile dallo stato salvato, e ogni referto sull'argomento sarà una
ricostruzione finché il campo non si scrive.

**D-e · §5.2 p.63 è viva e morde oggi.** Copertura del campionatore **40,7%**, con **03Z e 08Z a zero
campioni**. Il `catch { }` muto di `campionaStima` non distingue l'eccezione dal tasso non misurabile.

**D-f · L'osservatore non può dire nulla per mercato.** `ordiniPerMercato` è `null` in **920 campioni
su 920** oggi, motivo dichiarato: *«marketId redatto nelle righe di elenco del giornale»*
(`op:'manual-list'` scrive `requested.marketId: "0x[redacted-64hex]"`). L'unico motivo per cui questo
referto ha un libro per mercato è che esiste `data/osservazione-24h.jsonl`, che è un file di
osservazione **non versionato** e non un presidio.

---

## 9 · METODO, PER CHI VUOLE RIFARE IL CONTO

1. **Capitale a libro per mercato**: `data/osservazione-24h.jsonl`, 928 campioni oggi (~1/min),
   campo `libro.mercati[cid].{ordini,nozionaleUsd}`. Integrato con la regola di `stima-integrata`
   (un campione vale fino al successivo, **mai oltre due passi** = 120 s).
2. **Fascia**: `data/maker-offsets.json` — il record «fascia corta» lo scrive agent41 **nell'istante
   dell'ingresso** (`agent41-realloc-scheduler.js:2840`), quindi è il giudizio dello stesso codice che
   quota, non una ricostruzione. Vale **in un verso solo** (il file si scrive solo sui corti,
   `agent41:2815`), quindi l'assenza non prova «lungo» e per quel caso si calcola
   `(endDate − ingresso)/3600e3 ≤ 48 h`. **Riscontro: 6 su 7 concordi**; l'unico discorde
   (`0xc5f91324af`) ha `entratoAt` della selezione diverso dall'istante di scrittura dell'offset.
3. **Scadenza**: board ∪ catalogo di ripiego ⇒ **100% dei mercati risolti**, 0 senza fonte.
4. **Tasso**: `estimateAtCapital` (variante A) e `quadraticUserShare` alla posa vera (variante B) —
   **la stessa funzione**, argomento `d` diverso. La coincidenza A ≡ A′ lo dimostra.
5. **Finestre della posa dei lunghi**, dai riavvii di agent40 letti dal giornale
   (`op:'preesistenti-fotografia'`, che si scrive solo all'avvio): 08:21:56Z, 08:46:30Z, 13:56:44Z,
   14:58:01Z ⇒ 2,052¢ fino alle 08:22, 3,500¢ fino alle 08:46, 3,000¢ dopo.

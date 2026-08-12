# Quanti mercati regge $663,11 — 12 agosto 2026

**SOLA LETTURA.** Nessun ordine, nessun riavvio, nessuna modifica al codice operativo. KILL attivo,
bot FERMO, freno inserito per tutta la durata. **Nessuna implementazione: la decisione è dell'operatore.**

Rifacibile con `node scripts/quanti-mercati.js`; dati in `docs/quanti-mercati-dati.json`.

---

## 0 · Un difetto di modello trovato strada facendo, che cambia i conti

Nel repo convivono **due modelli** di quante share compra un capitale, e non coincidono:

| dove | formula | corretto? |
|---|---|---|
| `plan-to-orders` — **quello che piazza davvero** | `Q = capitale / (p_yes + p_no)` | ✅ le due gambe costano insieme ~$1 per coppia, qualunque sia il mid |
| `minSizeVerdict` — in `reward-operator-estimate` | `perSide = (capitale/2) / mid` | ❌ vero solo a mid = 0,50 |

**La divergenza è grande sui mid estremi.** A mid 0,055 con minimo 20: il secondo dice che bastano
**$2,20**, mentre per avere 20 share su entrambi i lati servono **~$20** — sottostima di **nove volte**.
A mid 0,744 con minimo 100 sovrastima di 1,5×. In questo documento uso il modello di `plan-to-orders`,
perché è quello che decide gli ordini veri. **Segnalato, non corretto** (sola lettura).

---

## 1 · Il vincolo duro — misurato sul board

**I due minimi sono cose diverse** e vanno tenute separate:

- **minimo d'ORDINE**: la soglia sotto cui il venue rifiuta l'ordine. Non è ciò che morde qui.
- **minimo PREMIANTE** (`min_incentive_size`): la soglia sotto cui il venue **accetta l'ordine ma non
  gli assegna punteggio** — `venue-rules.js:86`: *«size is below min_incentive_size — earns nothing»*.
  Nel nostro stack `BELOW_MIN_SIZE` è **bloccante** per scelta (§5 punto 54): un ordine che non matura
  premi immobilizzerebbe capitale per niente.

**Distribuzione reale, board attuale (118 mercati Polymarket):**

| min premiante | mercati | quota | capitale minimo per la coppia | max mercati con $663,11 |
|---|---|---|---|---|
| **20** | **86** | **73 %** | **$19,60** | 33 |
| 50 | 16 | 14 % | $49,00 | 13 |
| 100 | 6 | 5 % | $98,00 | 6 |
| 200 | 10 | 8 % | $196,00 | 3 |

**Non esiste un valore unico**: varia per mercato di un fattore 10. Ma **il 73 % dei mercati sta a 20**,
ed è quella la popolazione che decide il massimo.

Il costo della coppia al minimo è `minSize × pairCost`, con `pairCost ≈ 0,98` misurato sui piani veri
(§5 punto 48). **Non dipende dal mid**: è la proprietà che rende il conto semplice.

---

## 2 · Il massimo teorico

Riempiendo dai mercati più economici in su:

| scenario | mercati | capitale speso | residuo |
|---|---|---|---|
| capitale interamente impiegato | **33** | $646,80 | $16,31 |
| con riserva del 10 % (obiettivo utilizzo 90 %) | **30** | $588,00 | — |

Composizione del massimo: **33 mercati tutti a minimo 20**. I mercati a minimo 50/100/200 non entrano
mai nel massimo: costano 2,5–10× e il capitale rende di più spalmato sui minimi bassi.

**$663,11 non può stare su più di 33 mercati.** Il confronto con i due wallet affini (133–191 mercati)
non è una scelta di configurazione: è una **conseguenza del capitale**. Loro hanno un netto aperto
osservato di $3.673 e $29.007 — da 5× a 44× il nostro.

---

## 3 · L'ottimo — e la curva è piatta dove conta

Per ogni N: capitale per mercato = $663,11/N, si valutano tutti i mercati del board a quella size con
la formula del venue (`scoreOrder` + `qMin` sul `competitorQ` misurato da agent24), si tengono i
migliori N. Chi non qualifica al minimo premiante rende zero ed esce da solo.

| N | $/mercato | share/lato | lordo modellato senza tetto | **con tetto di credibilità 60 %** | resa/g |
|---|---|---|---|---|---|
| 5 | $132,62 | 135 | $303,28 | $209,15 | 31,5 % |
| 10 | $66,31 | 68 | $407,28 | $308,84 | 46,6 % |
| **11 (oggi)** | **$60,28** | 62 | $432,78 | **$330,56** | **49,8 %** |
| 15 | $44,21 | 45 | $493,38 | $409,54 | 61,8 % |
| **20** | **$33,16** | 34 | $560,64 | **$487,40** | **73,5 %** |
| 25 | $26,52 | 27 | $590,76 | $536,19 | 80,9 % |
| 30 | $22,10 | 23 | $598,24 | $555,07 | 83,7 % |
| **33 (massimo)** | **$20,09** | 21 | $598,86 | **$561,22** | **84,6 %** |
| 34+ | $19,50 | 20 → **sotto il minimo** | **$0** | **$0** | 0 % |

**La curva sale fino al vincolo e poi precipita a zero.** Non c'è un ottimo interno: l'ottimo *è* il
massimo. A N=34 il capitale per mercato scende a $19,50 contro i $19,60 necessari, e **ogni** mercato
smette di qualificare — reward zero ovunque, non «un po' meno».

**Ma la curva è piatta dove conta.** Fra N=25 e N=33 il guadagno è **+4,7 %**; fra N=20 e N=33 è
**+15 %**. Il salto vero è **da 11 a 20: +47 %**. Quindi: la scelta esatta fra 20 e 33 conta poco,
la scelta fra 11 e 20 conta molto.

**⚠ I livelli sono lordo MODELLATO, non cassa attesa.** La diagnosi del 465 % dice che il modello
sovrastima; l'8 agosto la stima fotografata era 13× l'incassato. **Va letto come ordinamento fra
scenari, mai come previsione.** Il tetto di credibilità al 60 % (la regola del repo) è applicato nella
colonna che uso: senza di esso la curva sarebbe più ottimista proprio a N basso, dove le share
modellate arrivano al 98 %.

---

## 4 · I costi che crescono con i mercati

| costo | come cresce | a N=30 | tetto del sistema | morde? |
|---|---|---|---|---|
| **residuo scoperto sotto soglia** | `f_min = minSize·pairCost / capitalePerMercato` | **89 %** | — | **SÌ, per primo** |
| sottoscrizioni book (agent34) | 2 asset per mercato | 60 asset | `TOTAL_MARKET_CAP` 125 mercati / 250 asset | no |
| rinnovi GTD | 2 gambe × 3 rinnovi/h | 180 req/h = **3/min** | carico flotta misurato 33,3 req/min | no (+9 %) |
| apertura da zero | `MAX_NUOVI_PER_GIRO` = 6, cadenza 10 min | **5 giri = 50 min** | — | no, ma va saputo |
| scansione board (agent24) | indipendente da N | — | 150 mercati, 15 min | no |

**Il vincolo che morde per primo non è tecnico: è il residuo scoperto.**

`f_min` è la frazione di fill sotto la quale il residuo scoperto **non è più piazzabile** (§5 punto 52 ①):

| capitale/mercato | N | f_min | significato |
|---|---|---|---|
| $130 | 5 | 15 % | quasi ogni fill lascia un residuo gestibile |
| **$65 (oggi)** | **10–11** | **30 %** | il valore scelto dall'operatore l'11 agosto |
| $33 | 20 | **59 %** | metà dei fill parziali lascia un residuo bloccato |
| $26 | 25 | 74 % | — |
| $22 | 30 | **89 %** | quasi ogni fill parziale lascia un residuo bloccato |
| $19,60 | 33 | **100 %** | **qualunque** fill parziale è irrecuperabile |

**Un effetto collaterale positivo, misurato**: abbassare il tetto **allarga** la finestra di mid
ammessa. Il tetto per ordine è `capitale/2 + 5`, e la gamba cara costa `Q × p_max`, quindi
`p_max ≤ 0,49 + 4,9/capitale`:

| tetto per mercato | finestra di mid ammessa |
|---|---|
| $65 (oggi) | [0,435 · 0,565] |
| $33 | **[0,362 · 0,638]** |
| $22 | [0,287 · 0,713] |

Il vincolo che §5 punto 67 registra come aperto — «$70 sblocca 2 mercati su 4» — si allenta da solo.

---

## 5 · Raccomandazione

### **20 mercati, tetto $33 per mercato ($16,58 per lato, ~34 share)**

**Il ragionamento, per intero:**

1. **Il massimo è 33, ma non si va al massimo.** A N=33 il capitale per mercato è $20,09 contro i
   $19,60 necessari: **2,5 % di margine**. Un mercato che ruota su un minimo più alto, un mid che si
   muove, un arrotondamento — e si cade sotto soglia, dove il reward non è «più basso», è **zero**.
   Stare sul bordo di un precipizio per il +4,7 % dell'ultimo tratto di curva non è un buon affare.
2. **Il grosso del guadagno è già preso a N=20**: $487/g modellati contro $330 di oggi, cioè **+47 %**,
   che è l'85 % di tutto il guadagno disponibile fino al massimo.
3. **`f_min` resta al 59 %**, contro l'89 % di N=30 e il 100 % di N=33. È il numero che l'operatore ha
   già usato l'11 agosto per scendere da $130 a $65, e resta la variabile di rischio dominante.
4. **La curva è piatta fra 20 e 33**, quindi il costo di sbagliare in difetto è basso.

**Se l'operatore accetta `f_min` al 74 %**, N=25 con tetto $26,50 dà $536/g modellati (+10 % su N=20).
È difendibile; non è quello che raccomando senza aver misurato la distribuzione dei fill parziali.

### Cosa cambierebbe

| parametro | oggi | proposto | note |
|---|---|---|---|
| `MARKET_CAP_FIXED_USD` | **$65** | **$33** | in `lib/rewards/concentration.js`, importato da 4 consumatori |
| size per lato | $32,50 | $16,58 | conseguenza, non parametro |
| mercati attesi | 10–11 | **20** | conseguenza: `capitale ÷ tetto` |
| `LIVE_MIN_ORDER_CAP_USD` | $37,50 | **$21,50** | **derivato** (`tetto/2 + 5`): si muove da solo |
| finestra di mid ammessa | [0,435 · 0,565] | [0,362 · 0,638] | conseguenza, e migliora |

**Altri parametri da rivedere di conseguenza:**

- **`MAX_NUOVI_PER_GIRO` = 6**: aprire 20 mercati da zero richiede 4 giri = 40 minuti. Accettabile, ma
  se si vuole la ripartenza rapida va alzato.
- **`profondita-minima` / scala di size**: §5 punto 54 misurava che «con il tetto a $65 solo 2 mercati
  su 132 stanno nella fascia in cui il book lega prima del tetto». A $33 il tetto lega ancora meno
  spesso e la scala di profondità diventa **quasi sempre inerte**. Va rimisurato.
- **Il tetto di credibilità (60 %)** morderà molto meno: a $33 per mercato le share modellate scendono
  dal 70 % al 43 % mediano. Non è un parametro da toccare, è un effetto da aspettarsi.
- **`accumulo-residui`**: con `f_min` al 59 % il registro dei residui si riempirà più spesso. Esiste ed
  è già cablato, ma la sua frequenza d'uso cambia di categoria.

**Cosa NON cambia**: il minimo premiante è del venue e non si tocca; la banda, «mai primo sul libro»,
il pavimento di orizzonte (18 h) e il guardiano delle perdite sono ortogonali a questa decisione.

---

## 6 · Misurato contro stimato

**Misurato:**
- distribuzione dei minimi premianti sul board (118 mercati) e costo della coppia;
- il massimo sostenibile, riempiendo coi minimi veri mercato per mercato;
- la curva di rendimento con la formula del venue sul `competitorQ` che agent24 misura sul book vero;
- i tetti tecnici (`SUBSCRIPTION_CAP` 90, `TOTAL_MARKET_CAP` 125, `MAX_RPS` 1,5, 3 rinnovi/ora per
  ordine, `MAX_NUOVI_PER_GIRO` 6), letti dai sorgenti;
- `f_min` e la finestra di mid, entrambe aritmetica sui parametri veri.

**Stimato o non misurabile:**
- **il livello del rendimento**: modellato, e il modello sovrastima (465 %). Solo l'**ordinamento** fra
  scenari è affidabile.
- **la distribuzione dei fill parziali**: è ciò che trasformerebbe `f_min` da rischio a costo atteso.
  Non è misurabile: il ledger ha pochissimi fill e il bot è fermo da giorni. **Servirebbero settimane
  di operatività con fill veri** — non giorni, e non si stima.
- **il costo in chiamate del riprezzo a N alto**: stimato dai rinnovi GTD (3/ora per ordine). Il ciclo
  di riprezzo ne fa altre quando il mid si muove, e quel tasso dipende dalla volatilità, non da N.
- **se i due wallet affini stiano sopra o sotto il minimo premiante**: le loro size sono per *fill*,
  non per ordine (vedi `wallet-affini-12ago.md`). Non si può dedurre come dimensionano gli ordini.
- **il board ruota**: 123 mercati un'ora fa, 118 adesso, e solo 5 degli 11 del piano di stamattina
  sopravvivono. I numeri assoluti valgono per questo board, le proporzioni reggono.

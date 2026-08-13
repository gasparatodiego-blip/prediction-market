# Dove conviene stare dentro la banda premiante — misurato

## 1 · La formula del venue — CERTEZZA ALTA, fonte ufficiale viva

Verificata su `docs.polymarket.com/market-makers/liquidity-rewards`, non ricostruita a memoria:

```
S(v, s) = ((v − s) / v)² · b          b = 1 per gli ordini standard
Q_min (mid ∈ [0,10 · 0,90]) = max( min(Q_bid, Q_ask), max(Q_bid/c, Q_ask/c) )   c = 3,0
```

| domanda | risposta | certezza |
|---|---|---|
| il tasso dipende dalla distanza dal mid? | **sì, QUADRATICAMENTE** | ufficiale |
| v, s | v = max spread dal mid **in centesimi**; s = distanza dal mid *aggiustato per la size-cutoff*, in centesimi | ufficiale |
| size in share o dollari? | **share**, non dollari | ufficiale |
| conta il tempo? | **sì**: **10.080 campioni per epoca**, cioè campionamento al minuto. Il punteggio si accumula per campione | ufficiale |
| soglia minima? | **sì**, una `minimum qualifying order size` **per mercato** (le nostre 20 share) | ufficiale, valore per-mercato |
| banda simmetrica? | **sì**, un solo parametro `v` per entrambi i lati; nessuna dipendenza dal prezzo descritta | ufficiale |
| pagamento | **giornaliero, a mezzanotte UTC** | ufficiale |

**Conseguenza diretta, e decide da sola la domanda**: al bordo `s → v`, quindi `S → 0`. Il bordo estremo
**non matura quasi nulla**, per costruzione.

## 2 · Dove stiamo davvero — 17.119 osservazioni

Parametri reali: **v = 2,25¢** (mediano), distanza mediana **1,0¢** ⇒ **s/v = 0,444**, **S = 0,3086**.

**Non siamo affatto al bordo.** Ma la distribuzione mostra un problema che non cercavo:

| fascia s/v | osservazioni | quota | **S medio** |
|---|---|---|---|
| 0–20% (vicino al mid) | 175 | 1,0% | 0,8699 |
| 20–40% | 5.794 | **33,8%** | 0,6022 |
| 40–60% | 3.599 | 21,0% | 0,3059 |
| 60–80% | 2.928 | 17,1% | 0,1112 |
| **80–100% (bordo)** | **4.623** | **27,0%** | **0,0076** |

**S medio effettivo sui nostri ordini: 0,2981.**

⚠ **Il 27% dei nostri ordini sta già al bordo estremo, con S = 0,0076 — quaranta volte meno della
nostra stessa mediana.** Quel capitale è a libro e non matura praticamente niente. Non è una scelta:
la regola del «bordo esterno se soli» non compare mai nel giornale (0 righe). È deriva del mid dopo il
piazzamento, cioè ritardo di riprezzo.

## 3 · Il costo vero di un fill — e qui l'ipotesi si rompe

Dai nostri dati reali (61 episodi su **317 ore**, cioè 13 giorni):

| | |
|---|---|
| episodi post-fill | **4,6 al giorno** |
| di cui chiusi con una **vendita** | **1,0 al giorno** (gli altri: merge 43%, redeem, ancora aperti) |
| costo di uscita mediano | **0,25 ¢/share** |
| ordine mediano | $10,50 ≈ 21 share |
| **spread pagato** | **≈ $0,05 al giorno** |
| residui lasciati | 18% degli episodi |

**Un fill ci costa cinque centesimi al giorno in spread.** È il numero che rompe l'ipotesi.

Il costo vero non è lo spread, è il **capitale immobilizzato**: $135 in 19 gambe nude. Al nostro
rendimento osservato ($4,40/giorno su $650 = 0,677%/giorno), quei $135 costano **$0,91/giorno** —
**diciotto volte** lo spread.

## 4 · Il punto di pareggio

Ancorato al reward osservato ($4,40/giorno a S = 0,2981), assumendo **reward ∝ S** — lecito perché la
nostra quota del monte premi è lo 0,0004%, quindi non muoviamo il denominatore.

| posizione | S | reward/g | spread/g | capitale fermo/g | **netto/g** |
|---|---|---|---|---|---|
| al mid (s/v = 0) | 1,0000 | $14,76 | ~$0,20 | ~$3,60 | **~$10,96** ⚠ irrealistico |
| s/v = 0,25 | 0,5622 | $8,30 | ~$0,10 | ~$1,80 | **~$6,40** |
| s/v = 0,40 | 0,3600 | $5,31 | ~$0,07 | ~$1,20 | **~$4,04** |
| **NOI (0,444 mediano, S eff. 0,2981)** | 0,2981 | **$4,40** | **$0,05** | **$0,91** | **$3,44** |
| s/v = 0,60 | 0,1600 | $2,36 | ~$0,03 | ~$0,50 | **~$1,83** |
| s/v = 0,75 | 0,0625 | $0,92 | ~$0,02 | ~$0,25 | **~$0,65** |
| **bordo (s/v = 0,889)** | 0,0123 | **$0,18** | ~$0,01 | ~$0,05 | **~$0,12** |
| bordo estremo (0,95) | 0,0025 | $0,04 | ~$0 | ~$0 | **~$0,04** |

**Il massimo sta verso il MID, non verso il bordo.** La curva è monotòna: il guadagno quadratico di
punteggio batte sempre il risparmio lineare sui fill, perché i fill costano cinque centesimi.

⚠ **Le colonne «spread» e «capitale fermo» sono SCALATE linearmente sul tasso di fill**, che non ho
misurato per fascia — non ho abbastanza fill nostri per farlo. È l'inferenza più debole della tabella,
ed è dichiarata. Ma l'ordine di grandezza regge: perché il bordo pareggiasse, un fill dovrebbe costare
**~$0,90 invece di $0,05**, cioè diciotto volte tanto.

**Verdetto sull'ipotesi: NON torna, e per un margine ampio.** Andare al bordo estremo distruggerebbe il
**96%** del reward per risparmiare $0,04/giorno di spread.

**Sul «bordo esterno per i mercati veloci»**: la regola in §4.1 scatta quando siamo **soli sul lato**,
non sui mercati veloci — e nel giornale **non scatta mai** (0 righe). Quindi non è né supportata né
smentita dai dati: **non è mai stata esercitata**.

## 5 · I tre scenari, a $650 e presenza 29/30

| scenario | S eff. | reward lordo/mese | spread/mese | capitale fermo/mese | **netto/mese** |
|---|---|---|---|---|---|
| **(a) attuale** | 0,2981 | $127,60 | $1,45 | $26,39 | **$99,76** |
| **(b) bordo estremo ovunque** | ~0,0123 | $5,22 | $0,29 | $1,45 | **$3,48** |
| **(c) ottimale: togliere la coda al bordo** | **0,4580** | **$196,04** | ~$2,90 | ~$52,78 | **$140,36** |

Lo scenario (c) **non sposta la nostra mira**: sposta solo il **27% di ordini che oggi finisce a
S = 0,0076** nella fascia dove sta già il 33,8% degli altri (S = 0,6022). S medio da 0,2981 a 0,4580,
cioè **+53%**.

⚠ **Incertezza, dichiarata**: il reward osservato ($4,40/giorno) poggia su **4 giorni di presenza**;
il costo di uscita su **13 vendite**. La distribuzione nella banda invece poggia su **17.119
osservazioni** ed è il dato solido. Servono **~15 giorni di bot acceso** per stabilizzare le stime di
reward e di costo dei fill.

## 6 · Le leve, per valore atteso

| # | leva | valore | sotto il nostro controllo? |
|---|---|---|---|
| **1** | **presenza 4/30 → 29/30** | **+$100/mese** (da $17,59 a ~$128 lordi) | **sì** — è il collo già misurato |
| **2** | **togliere la coda al bordo** (27% a S=0,0076) | **+$68/mese** (+$2,36/giorno) | **sì** — è ritardo di riprezzo |
| **3** | sbloccare i $135 in gambe nude | **+$27/mese** ($0,91/giorno) | **sì**, ma serve il redeem (§151) |
| **4** | più mercati coperti | **incerto**: il capitale è il vincolo, non i mercati | parzialmente |
| — | **posizione nella banda verso il bordo** | **−$96/mese** | sì, **ma è la direzione sbagliata** |

**Le prime due valgono insieme ~$168/mese contro i $17,59 attuali, e sono entrambe nostre.** La leva
che l'ipotesi proponeva è l'unica con segno negativo.

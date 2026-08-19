# R4 · L'erosione non è mai scattata perché la profondità non è mai crollata

**19 agosto 2026 — sola misura, nessuna soglia toccata.** Replay sui book del 18 agosto
(`data/mid-history-2026-08-18.jsonl`, integro), con il modulo **vero** `lib/maker/book-erosion.js`
(`zoneDepth` + `updateErosion`), non una reimplementazione: la domanda è se la soglia del 40% avrebbe
visto qualcosa, e una copia della formula non risponderebbe alla domanda.

## La risposta, in una riga

**Il crollo non c'è stato.** Nella vita dei nostri ordini la profondità davanti non è mai scesa sotto
il **58,9%** della propria baseline. La soglia del 40% non è tarata male: è lontana da tutto ciò che è
successo. Il fill è venuto **dal mid**, non dall'erosione.

## Gli scatti che ci sarebbero stati, per soglia

Solo sulle **vite reali** degli ordini — l'erosione si misura mentre l'ordine è a libro, e lo stato si
azzera a ogni riprezzo (regola 5 del modulo). Replicare l'intera giornata invece delle vite gonfia il
conteggio di un fattore ~6, ed è l'errore che questa tabella evita.

| soglia | scatti confermati | ordini coinvolti | letture singole sotto soglia |
|---|---|---|---|
| **40% (quella in servizio)** | **0** | **0** | **0** |
| 50% | 0 | 0 | 0 |
| 60% | 1 | 1 | 3 |
| 70% | 1 | 1 | 8 |
| 80% | 3 | 3 | 39 |

I tre scatti, per intero — e si vede che non sono crolli:

```
80%  16:39:43  cid_1f1c63908f6c @0,909   1772,88 su baseline 2521,71 = 70,3%
80%  16:39:43  cid_1f1c63908f6c @0,021   1833,48 su baseline 2582,31 = 71,0%
60%  22:39:44  cid_b180e9dc07c3 @0,023   1524,00 su baseline 2587,56 = 58,9%   (stesso a 70% e 80%)
```

**A 40% non c'è nemmeno una LETTURA SINGOLA sotto soglia**, prima ancora della conferma a due letture.
Non è «ha scattato una volta e la conferma l'ha fermato»: la profondità non ci è mai arrivata vicino.

## Il fill del 23:17:21, minuto per minuto

Unico fill della giornata: 56,5 share, completo, mercato `cid_73dd0550d8b7`. Sei secondi prima,
alle 23:17:15, era scattato il riprezzo per **band exit** (`|0,19 − 0,255| = 6,50¢ > ±4,50¢ + 1,00¢`).

Profondità davanti al nostro ordine a 0,19 sul book YES:

```
 -227 s   mid 0,245   bid 0,23  ask 0,26    280 share su 2 livelli
 -152 s   mid 0,245   bid 0,23  ask 0,26    260 share su 1 livello
  -77 s   mid 0,245   bid 0,23  ask 0,26    260 share su 1 livello
   -2 s   mid 0,255   bid 0,23  ask 0,28    260 share su 2 livelli
  +68 s   mid 0,325   bid 0,29  ask 0,36     77 share
```

**Piatta a 260 share fino a due secondi prima.** Poi, dentro un solo intervallo di campionamento, il mid
salta da 0,245 a 0,325 — **+8 centesimi in ~75 secondi**. Il crollo della profondità (280 → 77, −72%)
arriva **dopo** il fill, non prima: è la conseguenza del movimento, non il suo preavviso.

La gamba che si è riempita era sul book **NO** (il nostro BUY a ~0,72). Il mid NO è sceso da ~0,755 a
~0,675, cioè **è passato attraverso il nostro bid**. È lo stesso quadro misurato il 17 agosto sui fill
del 16 (§5-bis p.169): il prezzo attraversa, non si consuma la coda davanti.

## I tre limiti, dichiarati

1. **⚠ IL FEED CAMPIONA OGNI 75 s, IL BOT OSSERVA OGNI 5-10 s.** Cadenza mediana misurata su tutti e
   otto i mercati: **75,0 s** esatti (min 75,0, q90 75,009) — non i ~115 s scritti in §5.2 p.43.
   La conferma a due letture richiede quindi che il crollo duri **≥ 150 s** per essere visibile qui.
   **Un crollo più breve di così questo replay non lo vedrebbe**: i numeri sono un limite inferiore.
   Nella finestra di 120 s prima di ciascuno dei 13 eventi ci sono **0, 1 o al massimo 2 campioni**.
2. **⚠ `mid-history` REGISTRA UN BOOK PER MERCATO** (`tokenIdYes`). Le gambe sul book NO non hanno
   dati: **20 ordini su 67**, e il fill è avvenuto proprio lì. Per quella metà non si sa, e non si stima.
3. **⚠ 18 VITE SU 47 NON RISCALDANO NEMMENO LA BASELINE** (servono ≥5 campioni su ≥120 s): a 75 s di
   cadenza un ordine deve vivere ≥ 5 minuti per produrre un verdetto qualunque. Quelle 18 non avrebbero
   potuto scattare a nessuna soglia.

## Il perimetro della misura

67 ordini accettati · 8 mercati · 13 eventi (3 riprezzi della famiglia band-exit, 9 rinnovi per
scadenza, 1 fill) · 47 ordini misurabili · 592 campioni di book dentro le vite (12,6 per ordine) ·
51 ordini con una fine registrata a giornale, gli altri 16 con vita = GTD 1380 s.

## Cosa NON dice questa misura

Non dice che R4 sia inutile. Dice che **il 18 agosto non c'era niente da vedere**, e che la ragione per
cui non è mai scattata non è una taratura sbagliata. Il caso che R4 esiste per cogliere — la coda
davanti che si assottiglia *prima* che il prezzo si muova — in questa giornata non si è presentato:
il prezzo si è mosso e basta. Per sapere se si presenta mai serve una giornata con più fill, e
soprattutto **il feed del book NO**, che oggi manca.

## Due errori miei, prima di questi numeri

Vale la pena scriverli, perché sono la classe di §5-bis p.196.
① Ho chiamato `updateErosion(state, {t, depth}, cfg)` invece di `updateErosion(state, {depth, now, cfg})`:
`now` restava `undefined`, ogni giro rispondeva «orologio non leggibile», e il replay dava **zero scatti
a ogni soglia, in silenzio**. ② Il campo è `fired`, non `triggered`. Entrambi producevano un risultato
che sembrava una risposta. Il secondo replay, ristretto alle vite, ha corretto anche un terzo errore:
replicare l'intera giornata invece delle vite dava 6 scatti a 40% invece di 0.

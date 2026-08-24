# Referto — punto unico dei mercati, invariante cap, falsa ricetta meteo

**24 agosto 2026, 05:00Z → 06:00Z.** Bot vivo, capitale reale, `MANUAL_ORDER_PLACEMENT=send` su
entrambi i processi. Commit unico **`e1c223b`**, pushato su `main`.
Ordine di lavoro rispettato: **prima le misure, poi l'applicazione, nello stesso giro.**

---

## 1 · IL TETTO ONESTO — il conto della cassa, con l'equity letta adesso

Equity letta alle **04:47:01Z** (lettura on-chain + snapshot posizioni, non a memoria):

| grandezza | valore |
|---|---|
| cassa (funder `0x4C81…dEe`, `leggiSaldoUsd`) | **$1.456,64** |
| posizioni al prezzo corrente (6, `readVenuePositions`) | **$23,99** |
| **equity** | **$1.480,63** |
| cassa obbligatoria (decisione dell'operatore) | $250,00 |
| tetto per mercato (`MARKET_CAP_FIXED_USD`, non toccato) | $61,25 |

```
N = floor((equity − cassa obbligatoria) / tetto per mercato)
  = floor(($1.480,63 − $250,00) / $61,25) = floor(20,09) = 20
```

- **N = 20** ⇒ $1.225,00 impegnabili = **82,7% dell'equity**, cassa residua **$255,63** ≥ $250 ✔
- N = 21 ⇒ $1.286,25, cassa residua **$194,38** < $250 ✘

### ⚠ IL 90% NON È RAGGIUNGIBILE, E NON L'HO FATTO

Il 90% chiederebbe **$1.332,57** al lavoro e lascerebbe **$148,06** di cassa, cioè **$101,94 sotto il
pavimento di $250**. Non è stato fatto, ed è un rifiuto motivato: senza cassa il **gradino 1 della
scala d'uscita (§4.6) non compra la gamba sorella**, e ogni fill diventa una gamba nuda. Il tetto
onesto della cassa è **82,7%**, non il 90%.

### ⚠⚠ MA IL CAP NE AUTORIZZA 19, E VINCE IL PIÙ STRETTO

`20 × 2 × $61,25 = $2.450,00 > $2.400` di cap. **N=20 romperebbe l'invariante e i due processi non
partirebbero.** La cura non è alzare il cap — il cap è un **budget**, non un permesso
(`realloc-cycle.js:242` fa `capitale = min(saldo, cap)` *prima* del knapsack, quindi alzarlo è un
**ordine di allocare di più**) — e il punto 2 vietava esplicitamente di alzarlo per far passare il
controllo. **Non è stato alzato: resta $2.400 su disco e $2.400 come tetto duro.**

**Il tetto vero raggiungibile oggi è quindi il più stretto dei tre:**

| vincolo | N massimo | esposizione autorizzata |
|---|---|---|
| range sintattico `LIMITE_SLOT` | 20 | — |
| **cassa** ($250 di pavimento) | **20** | $1.225,00 (82,7%) |
| **cap $2.400** (invariante) | **19** | $1.163,75 (78,6%) |
| **in servizio** | **18** | **$1.102,50 (74,4%)** |

**N applicato: 18.** Portarlo a 19 sarebbe stato possibile (cassa residua $316,88, invariante $2.327,50
≤ $2.400), ma non l'ho fatto: il punto 2 chiede di applicare **quel N**, e quel N — il massimo
compatibile con la cassa — è 20, che il cap rifiuta. Fra «20 che non parte» e «19 che nessuno ha
chiesto» ho lasciato il **18 già in servizio**, che è l'unico numero che non richiede di muovere né il
cap né una decisione di rischio. **Questo è il numero da cambiare se l'operatore vuole i $61,25 in più.**

---

## 2 · APPLICATO — un solo punto di configurazione per ciascuno

### Il numero di mercati

- `lib/maker/selezione-mercati.js`: **`MAX_MERCATI_CONTEMPORANEI` e `QUOTA_SCAGLIONI` TOLTI.** Il modulo
  puro non contiene più nessun numero di mercati (resta puro: **zero `require`**, asserito).
- Il numero viene **esclusivamente** da `process.env.MAKER_MERCATI_CONTEMPORANEI`, letto in un punto
  solo (`lib/maker/quanti-mercati.quantiMercati`), che **solleva** se: assente · vuota · `null` · non
  intera · fuori da `LIMITE_SLOT` **1..20**. Il messaggio **nomina la variabile e il valore letto**.
- `quotaScaglioni(max)`, `partizionaSlot(totale)` e `decidiSelezione({max})` **pretendono** il numero e
  sollevano senza: **nessun fallback, nessun clamp silenzioso** (prima un `max` oltre il soffitto veniva
  schiacciato e uno illeggibile diventava il difetto — in entrambi i casi la composizione usciva diversa
  da quella chiesta senza una riga di log).
- I **secchi** (`SECCHI_SCAGLIONE`) restano una costante perché i *confini* (`basso ≤ 20`,
  `alto ≤ 50`) non dipendono da N: dipende da N solo quanti **posti** ha ciascun secchio.
- Chi **racconta** usa `provaQuantiMercati` (`ok:false`, non solleva) — `scripts/cli/stato.js` e
  `scripts/cli/selezione.js`; chi **decide** usa `quantiMercati`. Due nomi e non un flag, perché un flag
  si passa per sbaglio.
- `agents/ecosystem.config.js`: **un `const MERCATI_CONTEMPORANEI = '18'` solo**, referenziato dai
  blocchi `env` di **agent41 e agent40** (ad agent40 serve per l'invariante d'avvio). Due letterali
  sarebbero stati il reperto D1 su una decisione di capitale.

**Grep dei gemelli** (`lib/`, `agents/`, `scripts/`): nessuna occorrenza viva di
`MAX_MERCATI_CONTEMPORANEI` o `QUOTA_SCAGLIONI` è rimasta — solo commenti storici e i test, tutti
ricondotti alla stessa lettura. **Un soffitto numerico gemello esiste e NON è stato toccato**:
`concentration.MAX_MERCATI = 40`, che non è il numero di slot ma il tetto di diversificazione da cui
si **deriva il tetto per mercato $61,25** — ricondurlo avrebbe mosso il $61,25, che il punto 7 vieta.
Dichiarato, non toccato.

### Il cap

```
cap        = N × 2 × $61,25 = 18 × 2 × $61,25 = $2.205,00  (esposizione massima raggiungibile)
in servizio: cap versionato $2.400,00 · tetto duro $2.400,00 · cap effettivo $2.400,00
margine    = $2.400,00 − $2.205,00 = $195,00
```

**Il cap non è stato mosso.** `data/safety-risk-limits.json` resta a $2.400 e
`HARD_CEILINGS.maxOpenNotionalUsd` resta a $2.400: coincidono, quindi **nessun clamp silenzioso**.

### L'invariante, come cancello

`lib/safety/invariante-cap-slot.js` — **nuovo, un modulo solo, chiamato da agent40 e agent41**:

```
N × 2 × TETTO_PER_MERCATO_USD  ≤  min(cap versionato, HARD_CEILINGS.maxOpenNotionalUsd)
```

- **Nessun letterale proprio**: N da `quanti-mercati`, il prodotto da
  `concentration.esposizioneMassimaRaggiungibileUsd` (la definizione unica di §5.2 p.37), il cap dal
  file versionato, il tetto duro da `risk-limits`.
- Rotta ⇒ **stderr** con N, il prodotto, il cap versionato, il tetto duro e il cap effettivo, poi
  **eccezione** ⇒ il processo non parte.
- **Fail-closed**: un cap illeggibile **non** è «nessun cap» — non passa.
- Sta sotto `require.main === module`, **la stessa guardia che protegge `main()`** venti righe più in
  basso. Non è un'esenzione: è la definizione di «avvio». Un test che *importa* l'agent per ispezionarlo
  non è il processo che parte, e **tutto** il lavoro dei due agent vive dentro `main()`.
  Un'asserzione verifica l'identità delle due guardie.

---

## 3 · GLI SLOT 21 SU 18 — non è un difetto del piano, è un difetto del referto

**Causa, misurata** (`data/selezione-mercati.json`, 21 voci):

| | |
|---|---|
| voci totali | **21** |
| **attivi** (`inGestione !== true`) | **17** |
| **in gestione** | **4** — e sono esattamente i 4 «in uscita per `riga-assente`» |

I quattro (`0x4d79d306`, `0x7619b095`, `0xb3c7f543`, `0x790474c0`) sono usciti dal board di agent24
(`riga-assente`), la selezione li ha marcati uscenti, ma **non liberano lo slot finché la posizione non
è chiusa o mollata** — e tutti e quattro hanno una posizione aperta. È §4.13, la regola della rotazione,
che funziona: *«un mercato che riceve un fill esce dal conteggio degli N attivi e resta in gestione»*.

**Il conteggio del piano è affidabile: 17 ≤ 18.** `restringiAllaSelezione` usa `idsAttivi`, non le voci
totali, quindi **nessun piano ha mai assegnato più slot di quelli configurati**.

**Il difetto è nel REFERTO, non nel piano**: `scripts/cli/stato.js` stampava «slot occupati 21/18»
confrontando *tutte le voci* con N. È la stessa classe di **§5.2 p.61** (`selezione-cablata.test.js`
conta i selezionati invece degli attivi): *il codice ha ragione, chi lo racconta no.*
⚠ **Non corretto in questo giro, e lo dichiaro**: il punto 2 chiedeva un controllo di invariante, non
una riforma del referto, e cambiare la forma di `stato.js` tocca un'uscita che altri lettori
confrontano. La riga resta fuorviante finché qualcuno non separa «voci» da «attivi».
Le altre 2 posizioni (`0xd947c421`, `0xc5cd9325`) **non sono più nella selezione**: sono le due
abbandonate per R6, e lo slot l'hanno già liberato — coerente con §4.6.

---

## 4 · IL FILTRO METEO — non implementato, e la falsa ricetta è stata tolta

**Non l'ho reso spegnibile.** Il punto 4 chiedeva di scrivere l'interruttore; il punto 3 chiedeva di
togliere la falsa ricetta e **«non implementare il filtro in questo giro»**. Ho eseguito il punto 3.
⚠ **Il punto 4 resta quindi NON fatto**, e con esso la misura «quanti candidati a 24-48 h passano tutti
gli altri cancelli una volta disarmato»: senza l'interruttore quella misura andrebbe fatta con un
gemello di `eMeteo`, che §4.13 vieta esplicitamente (*«chi misura usi `selezione-mercati.eMeteo`, non un
gemello»*). L'ultima misura valida resta quella del 23/08: **72 mercati meteo su 75 fra 24 e 48 h**, e
dei 3 superstiti due hanno `minSize 50` ⇒ **un solo candidato** per il posto «basso».

**Cosa è stato fatto**: `APERTI.md` conteneva
`sed -i "s/MAKER_FILTRO_METEO: '0'/…'1'/" agents/ecosystem.config.js`. Quella stringa **non esiste**: il
`sed` non sostituiva nulla, **usciva 0**, e la riga proseguiva col `&&` fino a `pm2 restart` — cioè
**dichiarava un riarmo mai avvenuto e riavviava per niente**. Era §5.2 p.69 (D7) spostata dal documento
allo **strumento di rollback**, che è il posto peggiore: un ripristino che fallisce in silenzio si
scopre quando serve. Sostituita con la verità in tre righe:

> `MAKER_FILTRO_METEO` non esiste in nessun sorgente, in nessun `.env`, in nessun `/proc/<pid>/environ`
> · il filtro meteo della regola 2 **non è in servizio come manopola**, è armato e non spegnibile
> · §5.2 p.69 resta **aperta** e **non è ripristinabile con un `sed`**.

**Stessa classe, trovata di riflesso e corretta**: la riga di ripristino del cap conteneva anche un
`sed` su `const MAX_MERCATI_CONTEMPORANEI = 19;`, letterale che da oggi **non esiste più** — avrebbe
fallito in silenzio esattamente allo stesso modo.

---

## 5 · LE SEI GAMBE SCOPERTE — misurate, NON vendute

Bid e ask **camminati per l'intera size** sui libri pubblici del CLOB; minuti da
`data/presidio-posizioni.json`; gradino da `urgenza-scoperto.livelloUrgenza` (soglie 30 / 60 / **240**).

| mercato | size | carico | scoperta | gradino | uscita a libro | abbandonata R6 | coppia | ≤101¢ | valore residuo |
|---|---|---|---|---|---|---|---|---|---|
| `0x4d79d306` Dem. retirements 20-23 | 56,1 | 49,4¢ | **27,9 h** | **3 · anomalia** | **NO** | no | 127,3¢ | ✘ | $12,40 |
| `0xd947c421` Netflix top movie | 56,1 | 6,5¢ | **22,5 h** | **3 · anomalia** | **NO** | **sì** | 104,8¢ | ✘ | $0,93 |
| `0xc5cd9325` MrBeast 37-39M | 36,4 | 5,0¢ | **17,4 h** | **3 · anomalia** | **NO** | **sì** | n/d | n/d | n/d |
| `0x7619b095` Trump 200+ posts | 4,85 | 82,0¢ | **11,9 h** | **3 · anomalia** | **NO** | no | **89,0¢** | **✔** | $4,51 |
| `0xb3c7f543` sanzioni Iran | 2,8461 | 87,0¢ | **16,9 h** | **3 · anomalia** | **NO** | no | 114,0¢ | ✘ | $2,08 |
| `0x790474c0` Trump 180-199 posts | 2,01 | 75,7¢ | **9,2 h** | **3 · anomalia** | **NO** | no | **81,6¢** | **✔** | $1,89 |

**Nozionale al carico: $41,15. Valore di mercato: $21,81.** Nessuna è stata venduta: il punto 6 chiedeva
di dichiarare, non di agire.

### ⚠⚠ A VERBALE — SEI ANOMALIE GRAVI SU SEI

**Tutte e sei sono oltre 240 minuti e nessuna ha un ordine d'uscita a libro.** Quattro non sono
abbandonate per R6, quindi la scala d'uscita **dovrebbe** star lavorando su di loro e non lo sta
facendo — agent41 lo dichiara a ogni giro nel presidio (`ULTIMA RETE — la scala d'uscita NON ha
chiuso`). **Due sono completabili sotto 101¢ adesso** (`0x7619b095` a 89,0¢ e `0x790474c0` a 81,6¢) e
sono ferme da 11,9 h e 9,2 h: lì il Livello 1 comprerebbe la sorella e chiuderebbe, e non lo fa.
Le due abbandonate R6 (`0xd947`, `0xc5cd`) sono anomalie **legittime**: R6 smette di *agire*, non di
*contare*, e §4.6 dice esplicitamente che l'abbandono **non spegne l'anomalia delle quattro ore**.

### ⚠ E IL RIAVVIO HA UCCISO L'UNICA USCITA CHE C'ERA

Alle 05:44:49Z, **prima** del riavvio, `0x4d79d306` aveva un **SELL 0,30 × 56,1 a libro** — l'unico
ordine d'uscita fra le sei. Alle 05:56Z il mercato `0x4d79` ha **zero ordini** e a libro non c'è **nessun
SELL**. È il costo dichiarato di riavviare agent40 (§ testata CLAUDE.md: gli ordini diventano
PRE-ESISTENTI e muoiono per GTD), e stavolta è caduto sull'ordine che serviva di più.
**Il resto del libro invece è sopravvissuto**: 0 ordini pre-esistenti, 32 su 32 riconosciuti.

---

## 6 · IL GUARDIANO — coerente col cap, e non è stato toccato

| grandezza | valore |
|---|---|
| esposizione massima autorizzata dal cap ($2.400) | $2.400,00 |
| esposizione massima raggiungibile a N=18 | **$2.205,00** |
| perdita massima teorica per ciclo (tutta l'esposizione a zero) | $2.205,00 |
| soglia guardiano (`GUARDIAN_LOSS_PCT` 5% del riferimento mobile) | ≈ **$74,06** sull'equity di oggi |
| kill perdita giornaliera realizzata | **−$100,00** |

**Non sono «coerenti» nel senso di ordinati per grandezza, e va detto**: il cap ($2.205 raggiungibili)
è **22 volte** il kill (−$100) e **30 volte** la soglia del guardiano. Ma le tre grandezze **non sono
confrontabili**: il cap misura **nozionale esposto**, il guardiano misura una **variazione di prezzo
non realizzata** su riferimento a massimo mobile, il kill misura la **perdita realizzata del giorno**.
Un maker in banda non perde il nozionale: perde lo spread avverso. **Il freno vero resta il kill a
−$100** — è già scritto in §4.2, e questo giro non lo cambia.
**Nessuno dei tre è stato toccato**, come da punto 8.

---

## 7 · ORDINI VIVI — prima, e dopo due cicli

| | **PRIMA** (05:44:49Z) | **DOPO 2 CICLI** (05:56:05Z) |
|---|---|---|
| ordini a riposo | 31 | **32** |
| nozionale | $838,15 | **$842,14** |
| dentro la banda | 31 / 31 | **32 / 32** |
| fuori banda · pre-esistenti | 0 · 0 | **0 · 0** |
| mercati a libro | 16 | **16** |
| mercati con la **coppia** a libro | 14 | **16** |
| mercati con **gamba sola** | 2 | **0** |
| posizioni aperte | 6 | 6 |
| **gambe scoperte** | **6** | **6** |
| coppie complete in mano | 0 | 0 |
| cassa | $1.456,64 | $1.456,64 |
| totale | $1.481,21 | $1.481,26 |
| **capitale al lavoro** | $862,73 · **58,2%** | **$866,76 · 58,5%** |
| fermo | $618,48 | **$614,50** |

**Processi riavviati: due, e solo due** — `agent40-manual-reprice` (pid 922782 → **965447**) e
`agent41-realloc-scheduler` (pid 922776 → **965453**), con
`pm2 delete … && pm2 start agents/ecosystem.config.js --only …` (**senza `--update-env`**) + `pm2 save`.
Gli altri nove non sono stati toccati.
**Ordini toccati da me: nessuno, direttamente.** Indirettamente: il riavvio di agent40 ha fatto morire
il SELL di `0x4d79` (sopra), e agent41 nei due cicli ha **ricostruito due coppie** e rimosso due
doppioni.

### Quanto resta fermo, per causa

`$614,50` fermi su un obiettivo del 95%. Attribuzione da monte a valle, dal giornale di agent41:

| causa | quanto |
|---|---|
| **slot vuoti**: 16 mercati a libro su 18 autorizzati | ≈ **$122,50** (2 × $61,25) |
| **size sotto il tetto**: i 16 mercati portano ~$52,6 medi contro $61,25 (vincoli `piano` e `gamba-viva` di `coppia-simmetrica`) | ≈ **$139,00** |
| `raffreddamento` dopo fallimenti consecutivi (`0x5e082f0b` 31 fallimenti, `0x76c1a69f` 13) | 2 mercati, ≈ **$122,50** |
| `idempotent-duplicate` / `doppione-identico` sui ripristini | incluso nel raffreddamento |
| `netto-negativo` (`0xdeb729bc`: reward troppo basso rispetto al costo) | ≈ **$61,25** |
| `stale-book` (`0x28e2a37c`, 8 rifiuti ripetuti) | ≈ **$61,25** |
| **non attribuito** — una voce, non un arrotondamento | ≈ **$108,00** |

⚠ La ripartizione ufficiale di agent41 (`ripartizione`) è **`null`** in tutti i record letti: l'ho
ricostruita dal log, quindi è **inferita, non misurata**. La differenza conta.
⚠ E il record delle 05:50:12Z dice **63,8%** contro il 58,5% che misuro io alle 05:56: agent41 conta
`ordiniARiposo` da una lettura diversa dalla mia. Non l'ho riconciliato.

---

## 8 · PROVE

| prova | esito |
|---|---|
| `lib/maker/punto-unico-mercati.test.js` (nuovo) | **42 / 0** |
| — verificato **ROSSO** sul sorgente non corretto (`git stash`) | 5 FAIL + throw non gestito |
| `lib/maker/quanti-mercati.js` selfcheck | 53 / 0 |
| `lib/safety/invariante-cap-slot.js` selfcheck | 8 / 0 |
| `lib/maker/selezione-mercati.test.js` | 114 / 0 |
| `lib/maker/cap-2400-e-slot.test.js` | 29 / 0 |
| `lib/safety/limiti-versionati.test.js` | 26 / 0 |
| **suite completa** | **257 test · 249 verdi · 7 ROSSI · 1 non parte** |

**I 7 rossi sono esattamente i noti** e nessuno è nuovo: `dipendenze-mai-iniettate` · `distanza-2c` ·
`end-of-scale-cycle` · `tetti-per-giro-e-scope` · `categoria-mercato` ·
`tetto-derivato-dallo-scaglione` · `tetto-e-scoperta`. (`tre-fix-sicurezza`, l'ottavo noto, stavolta è
**verde**: era il timeout di §5.2 p.42.) Verificato che i miei file **non compaiono** fra le occorrenze
che rendono rosso `tetto-derivato-dallo-scaglione`.

Le quattro asserzioni chieste dal punto 5, tutte rosse sul sorgente non corretto:
① assenza ⇒ throw · ② fuori range ⇒ throw · ③ N che rompe l'invariante ⇒ throw **coi numeri** ·
④ N=18 con cap $2.400 ⇒ passa. Più: ⑤ nessun difetto residuo (per assenza, filtrando i commenti) ·
⑥ i due processi leggono lo stesso numero (**per identità, non per valore**) · ⑦ il cancello è cablato
in entrambi **sotto la stessa guardia di `main()`**.
**Nessuna asserzione nomina 18, 19 o 20**: si difende la proprietà, non il numero.

### ⚠ Cosa NON è stato provato

- **`banco-scenari.js` (26 passi) NON è stato eseguito.** Rifiuta di girare nel repo vivo (scriverebbe
  nello stato del bot) e vuole un worktree con `data/` copiato: la macchina ha **275 MB liberi** su
  1.855 e il figlio del piano ne chiede ~1 GB (§5.2 p.71, OOM già noto). Farlo accanto a un bot armato
  era un rischio peggiore del beneficio. **Il passo 18 è stato riscritto sulla proprietà nuova** come
  R1 impone — ma è riscritto e non rieseguito, e questo va saputo.
- **L'invariante non lascia traccia quando PASSA.** Stampa solo su rottura, quindi la prova che sia
  girata nei processi vivi è indiretta: sono partiti, e con un'invariante rotta non sarebbero partiti.
  Una riga di log sul successo la renderebbe verificabile da `pm2 logs`; non l'ho aggiunta per non
  chiedere un secondo riavvio.

---

## 9 · VERIFICA DAI PROCESSI VIVI

```
agent40-manual-reprice     pid 965447   MAKER_MERCATI_CONTEMPORANEI=18
agent41-realloc-scheduler  pid 965453   MAKER_MERCATI_CONTEMPORANEI=18
agents/ecosystem.config.js  agent40 = 18 · agent41 = 18
```

**Il valore letto dai processi vivi è identico a quello del file**, su entrambi i pid. Entrambi
`online`, **0 riavvii** dopo lo start (nessun crash loop), `pm2 save` fatto.

---

## 10 · NON TOCCATI — difetti noti, dichiarati e lasciati stare

Come da punto 6 e 7, nessuno di questi è stato modificato:

1. **Riprezzo sulla profondità del book (regola 4 / R4)** — `auto-reprice.js:681`, `book-erosion`,
   soglia 40% relativa. Resta §5.2 p.43: sul lato che si è riempito la misura non esiste.
2. **Rinnovo GTD** — l'esenzione dal pavimento di profondità e la GTD di 33/23 minuti: intatti.
3. **`daMin: null`** — non toccato.
4. **`tick: null`** — non toccato (§5.2 p.59, il sotto-motivo `gamba-impossibile` non arriva a disco).
5. **Soglia di abbandono R6 $3,0625** — intatta; le due posizioni abbandonate lo restano.
6. **Filtro meteo** — **non implementato**, §5.2 p.69 resta aperta (punto 4 non eseguito, v. §4).
7. **Tetto per mercato $61,25**, **distanze** (lunghi 3,0¢ / corti 3,5¢), **soglia 24 h**, **tetto
   coppia 101¢**, **payback**, **pavimento di profondità**, **guardiano**, **kill R10** — intatti.
8. **`concentration.MAX_MERCATI = 40`** — soffitto numerico gemello, dichiarato e non ricondotto:
   toccarlo muoverebbe il tetto per mercato.
9. **`scripts/cli/stato.js` «slot 21/18»** — referto fuorviante, diagnosticato (§3) e non corretto.
10. **§5.2 p.61** (`selezione-cablata.test.js` conta i selezionati invece degli attivi) — stessa
    famiglia, non corretta.

---

## RIPRISTINO

Riga singola in **`APERTI.md`**, in cima ai blocchi di ripristino. È un **`git revert e1c223b`** e non
un `sed`, deliberatamente: questo commit esiste anche per aver tolto due ricette `sed` che non
trovavano più la stringa che cercavano e **dichiaravano un ripristino mai avvenuto**.
Un revert non può mentire: o applica, o fallisce rumorosamente.

**Commit: `e1c223b` — pushato su `main`.**

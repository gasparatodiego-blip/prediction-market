# Referto — 23 agosto 2026, 14:5xZ

## Il rinnovo che non passava: un filo tagliato dentro `valutaMercato`, inerte da sette giorni

**PRIMA la misura, POI l'applicazione, nello stesso giro.** Ogni numero qui sotto è letto dal
giornale, dal libro vivo o dal codice: nessuno è ricordato.

---

## 0 · Stato dichiarato PRIMA di toccare (punto 7)

Letto dal venue con l'adapter **cancel-only** alle **14:12:46Z** (nessuna superficie di piazzamento
caricata), più `data/venue-positions.json` e `data/posizioni-abbandonate.json`.

| | |
|---|---|
| ordini a riposo | **29** su **15** mercati · nozionale **$789,35** |
| età degli ordini | media **11,9 min** · mediana 11,1 · max **17,2** (GTD 23 min) |
| coppie complete a libro (due token, stesso mercato) | **12** |
| gambe sole a libro | **3** mercati (`0x4e4f77e7` una gamba; `0x790474c0` e `0x4d79d306` una gamba + il SELL d'uscita) |
| posizioni aperte | **5**, tutte **scoperte** (zero coppie), valore al venue **$35,87** |
| di cui **ABBANDONATE** (R6) | **2** — `0xc5cd9325` MrBeast (valore $0,32, uscita $1,50) e `0xd947c421` Don't Say Good Luck (valore $1,52, uscita $2,12) |
| restano gestite | `0x4d79d306` Democratic House · `0x790474c0` Trump 180-199 · `0xb3c7f543` Iran |
| capitale al lavoro | **$778,13 / $1.489,43 = 52,2%** (obiettivo 95%) |
| flotta | 11 definiti, **10 online** + `agent44` in `waiting restart` (schedulato) |

**Processi riavviati: due, e solo due — `agent40-manual-reprice` e `agent41-realloc-scheduler`**,
insieme e **dal file**. Sono i soli che caricano il codice toccato: agent40 esegue il ciclo di
riprezzo (`auto-reprice`) e il motore (`motore-unico`); agent41 carica lo stesso motore per la
corsia di riallocazione.
**Ordini toccati da questo lavoro: ZERO.** Nessuna cancellazione, nessun piazzamento, nessuna
modifica di prezzo. **Le posizioni aperte non sono state vendute.**
⚠ Conseguenza nota e dichiarata (CLAUDE.md, riquadro in cima): **ogni riavvio di agent40 rende
PRE-ESISTENTI gli ordini già a libro** — invisibili al motore, quindi né riprezzati né rinnovati — e
quelli muoiono per GTD entro ≤ 23 minuti, poi il ciclo normale li ripiazza. ⚠ Il riavvio di agent41
azzera anche la quarantena in memoria della regola «slot sterile» (`statoLibroVuoto`): non è un
disarmo — per 22 minuti nessuno può essere rilasciato — ma è una perdita del freno anti-churn.

---

## 1 · La causa: quale presidio, quale file, quale riga (punto 1)

> ### 🔴 IL PRESIDIO È IL **PAVIMENTO DI PROFONDITÀ**, E I 49 SONO **TUTTI E 49** SUOI
> `motore-unico.trovaLivello` · `DEPTH_FLOOR_PCT_OF_AVG` · bocciatura `profondita-insufficiente`,
> prodotta a **`lib/maker/motore-unico.js:426`** e trasformata in `gate: 'motore-non-conforme'` a
> **`lib/maker/auto-reprice.js:1751`**.

**I 49, divisi per sottocausa** — finestra del referto precedente, 06:13Z → 13:18Z, contati sulle
righe `scaduto-senza-rinnovo` del giornale:

| sottocausa | quanti | nozionale | è il caso che l'esenzione copre? |
|---|---|---|---|
| **`la banda finisce prima del pavimento`** | **39** | **$260,66** | **sì** |
| `banda premiante non calcolabile` | 8 | $227,65 | no — manca un dato, non è un giudizio di liquidità |
| `dentro la banda c'è 1 livello: la ricerca parte dal secondo` | 2 | $9,98 | no — la guardia sta **prima** del pavimento |

Totale del giro: **63 morti · $862,58** — `motore-non-conforme` 49, `close-sell-floor` 5,
`rate-limited` 4, non dichiarata 5. **Riprodotto al numero**, non ricopiato dal referto di stamattina.

### La soglia, e come è dimensionata

```
pavimento = DEPTH_FLOOR_PCT_OF_AVG × (liquidità ALTRUI media in banda di QUEL mercato)
          = 0,10 × media_altrui                       (fonte `media-altrui`)
ripiego   = $15                                       (mercato senza storico)
```

**È una soglia RELATIVA, e questo è il punto**: non dice «questo libro è sottile», dice «questo libro
è più sottile della propria media recente». Sui 39 (ultima osservazione per ordine, dal giornale):

| grandezza | mediana | min | max |
|---|---|---|---|
| pavimento richiesto | **$170,44** | $26,03 | $46.666,47 |
| profondità **altrui** davanti, misurata | **$106,50** | $6,80 | $11.958,75 |
| media altrui in banda del mercato (= pavimento/0,10) | **$1.704,45** | $260,27 | $466.664,67 |
| rapporto davanti/pavimento | **0,536** | 0,114 | 0,959 |

**Fonte del pavimento: `media-altrui` in 39 casi su 39.** Mai il ripiego.

---

## 2 · Il rinnovo non è un ingresso — quali presidi sono legittimi (punto 2)

**L'esenzione esisteva già, ed è quella giusta.** `lib/maker/esenzione-rinnovo.provaRinnovo`, scritta
il **16 agosto** (commit `63c10a0`, 16:05Z) proprio per chiudere §5.2 p.21, con 21 prove interne
tutte verdi. **Non ne serviva una nuova.**

> ### 🔴 ERA INERTE DA SETTE GIORNI: IL FILO ERA TAGLIATO A METÀ STRADA
> `auto-reprice.js:1709-1716` costruisce la prova e la passa come `rinnovo:` dentro l'oggetto di
> `valutaMercato`. Ma **`motore-unico.valutaMercato` (`:369-380` del sorgente di ieri) non
> destrutturava `rinnovo`**, e a **`:422-423`** chiamava `trovaLivello({side, bookLevels, bandBounds,
> ownOrders, tick, pavimentoUsd, scoringMid, bandRadiusCents})` — **senza `rinnovo`**. Il parametro
> arrivava all'unica funzione che non lo riceveva.
> `trovaLivello` sapeva esentare (`:202`, `if (esenteRinnovo) pavimentoUsd = 0`) e non è mai stato
> raggiunto da un `rinnovo` diverso da `null`, mai, in sette giorni.
>
> **È la SESTA occorrenza in questo repo della classe «una dep col nome giusto che nessuno inietta è
> un valore di difetto che nessuno ha chiesto»** — con un'aggravante: le altre cinque avevano un
> ricevitore senza mittente, qui **mittente e ricevitore c'erano entrambi** e il filo era spezzato
> nel modulo di mezzo. Le prove del mittente (21, verdi) chiamano `provaRinnovo` direttamente; quelle
> del ricevitore chiamano `trovaLivello` direttamente. **Nessuna delle due passava dal ponte.**
> ⚠ E **`scripts/dipendenze-scollegate.js` non poteva vederlo**: cerca `deps.*` non iniettate, e
> `rinnovo` è un argomento nominato, non una dep. Dichiarato al punto 11.

### Chi è legittimo su un rinnovo e chi no

| presidio | su un rinnovo | perché |
|---|---|---|
| **pavimento di profondità** | ❌ **NON legittimo** | limita l'**apertura** di esposizione su un libro sottile. Un rinnovo non apre: sposta un ordine già a libro a size e nozionale **non crescenti**. Il termine di paragone non è «nessuna esposizione» (non è un'opzione) ma «la gamba muore e restiamo direzionali», che è il rischio peggiore |
| **mai primo sul libro** | ✅ legittimo | non parla di esposizione: parla di dove finisce il prezzo. Un rinnovo in cima al libro è comunque un ordine che si fa mangiare. Resta **assoluto** (asserito) |
| **tetto per mercato** (Regola 5) | ✅ legittimo | l'esenzione qui è quella di **chiusura**, che esiste già ed è provata a parte. Resta applicato (asserito) |
| **banda premiante** | ✅ legittimo | fuori banda l'ordine non matura premio: rinnovarlo lì è capitale immobile per definizione |
| **fine scala · mid stantio · KILL · rate limit · tetto per ordine** | ✅ legittimi | nessuno dei cinque parla di profondità del libro, e nessuno è toccato |

### Cosa è cambiato nel codice — tre righe, e tutte in una direzione

1. **Il filo** — `motore-unico.valutaMercato` destruttura `rinnovo` e lo inoltra a `trovaLivello`.
2. **Il prezzo di riferimento è quello che PARTE, non quello che c'è già** — `auto-reprice` passava
   `price: order.price` alla prova, mentre a `valutaMercato` passava `proposedPrice: d.targetPrice ??
   order.price`. Due espressioni per la stessa domanda: un **inseguimento al rialzo** si sarebbe
   dichiarato «rinnovo» sul prezzo vecchio e sarebbe passato con **più** nozionale a riposo. Adesso è
   `const prezzoCheParte`, **un numero solo**, letto da entrambe.
3. **Il prezzo di riferimento va nello spazio del motore** — su una gamba **SELL** `scalaPerIlMotore`
   specchia i prezzi (`p → 1−p`); `prezzoMassimo` nasce dagli ordini veri, non specchiati. Si specchia
   con la **stessa** funzione che ha specchiato la scala. Le condizioni ② e ③ (size, nozionale)
   restano nello spazio vero: sono un conto in dollari e non si specchiano.

> ### ⚠ LA PRIMA STESURA ERA SBAGLIATA, E L'HA DETTO LA MISURA, NON IL RAGIONAMENTO
> Inoltrare `rinnovo` e basta sembrava la correzione ovvia. Provata a secco sugli **11 ordini vivi**
> dei mercati che avevano perso gambe: **recuperava 1 rifiuto e ne CREAVA 4** — quattro ordini che
> passavano prima e non passavano dopo.
> **La causa**: `prezzoMaxRinnovo` dentro `trovaLivello`, che scarta i livelli più cari dell'ordine
> sostituito. Esiste per proteggere il prezzo **restituito** da quella funzione — ma sul percorso del
> riprezzo `valutaMercato` è un **VETO** e il prezzo lo sceglie `decideReprice`. Il commento che lo
> giustificava («nel ciclo di riprezzo la size è nota ma il prezzo no: lo sceglie questa funzione»)
> **descriveva un comportamento inesistente**: è un reperto **D7** appoggiato sopra il filo morto.
> **Le due correzioni**:
> · l'esenzione si applica **solo al ritenta**: si valuta col pavimento PIENO, e solo se cade e solo
>   se il rinnovo è provato si rivaluta con l'esenzione. Così può **solo** trasformare un rifiuto in
>   un'accettazione — proprietà **strutturale**, vera qualunque cosa faccia `trovaLivello` dentro;
> · se il pavimento era soddisfatto e a scartare sono stati **solo i prezzi**, il rinnovo è ammesso e
>   il prezzo è **quello che l'ordine ha già** (`prezzoDiRiferimento: true`, `level: null`). *Un
>   rinnovo non ha bisogno di un livello nuovo: ha bisogno di tenere il suo.* Non si restituisce mai
>   un livello più caro — asserito su tutti i rinnovi esentati del test.

---

## 3 · Il rifiuto era giusto? (punto 3) — **NO, e non per opinione**

**Nessuno dei 10 mercati coinvolti nei 39 è diventato illiquido. Zero slot da liberare.**

| mercato | ordini | profondità **altrui davanti** | pavimento richiesto |
|---|---|---|---|
| `cid_938e6a0a` **Bad Bunny** (il caso del prompt) | 2 | **$543,75 – $607,04** | $616,77 – $632,68 |
| `cid_4e4f77e7` | 5 | $11.460 – $11.959 | $46.551 – $46.666 |
| `cid_2c00cb09` | 6 | $2.348 – $2.578 | $3.492 – $3.591 |
| `cid_a34edb6c` | 2 | $310,57 – $312,42 | $529,13 – $540,98 |
| `cid_be1ff656` | 8 | $83,08 – $213,70 | $159,08 – $293,79 |
| `cid_d947c421` | 1 | $103,72 | $138,73 |
| `cid_790474c0` | 4 | $6,80 – $63,29 | $59,54 – $73,74 |
| `cid_aa74d4f5` | 8 | $31,54 – $50,53 | $79,44 – $146,76 |
| `cid_3492e563` | 2 | $48,55 | $162,83 – $165,71 |
| `cid_4d79d306` | 1 | **$11,72** | $26,03 |

**Il metro assoluto è il ripiego del pavimento stesso: $15** — quanto il motore chiede a un mercato
di cui non sa niente. **37 ordini su 39 stanno sopra**, mediana **$106,50**, cioè **7×** il ripiego.
Bad Bunny è la dimostrazione più netta: **$543,75 di liquidità altrui davanti** — un libro
profondissimo — respinto perché $543,75 < $616,77, cioè il 10% di una media recente di **$6.168**.
Il mercato non è diventato illiquido: **è la sua stessa media di ieri a fargli da giudice**.

Un solo ordine su 39 (`cid_4d79d306`, $11,72 davanti) è sottile anche in assoluto — ed è su
Democratic House, mercato che ha una **posizione aperta** ed è quindi già `inGestione`, fuori dal
conteggio degli slot. **Non c'è nessun mercato da dichiarare non più quotabile**, e non ho aggiunto
nessun meccanismo per farlo: sarebbe macchinario nuovo su capitale reale senza un caso che lo chieda.

---

## 4 · L'allarme: il degrado silenzioso finisce (punto 4)

`lib/maker/auto-reprice.js` — quando un ciclo perde ordini per GTD, ne scrive **una riga sola**,
marcata `anomalia: true`:

```
outcome: 'anomalia-scadenze-senza-rinnovo' · anomalia: true · corsia: 'rinnovo'
reason : "ANOMALIA: N ordini morti per GTD senza rinnovo in questo ciclo · $X usciti dal libro
          su M mercati · per gate: motore-non-conforme×49, rate-limited×4, … "
observed: { ordini, nozionaleUsd, senzaNozionale, mercati, perGate, orderIds }
```

**Perché non bastavano le righe per ordine.** `scaduto-senza-rinnovo` c'era già, una per ordine, e
in un giornale che ne scrive centinaia all'ora una morte in più è indistinguibile da una riga di
routine: i 63 morti di stamattina sono stati visti **contandoli a posteriori con un grep**. Il
degrado non era silenzioso per mancanza di righe — era silenzioso perché **nessuna riga diceva
QUANTO**.
⚠ **È un referto, non un gate**: non ferma niente, non cancella niente, non tocca ordini.
⚠ **Si scrive solo se qualcuno è morto in quel giro**: un avviso che compare sempre non è un avviso
(asserito per assenza).
⚠ **Il nozionale è la somma di ciò che si è potuto misurare**, e chi non si è potuto misurare si
conta a parte (`senzaNozionale`) invece di entrare come zero. «Non ho letto» non è «non c'è».

---

## 5 · Simulazione a secco (punto 5)

`scripts/ricerca/rinnovo-simulazione-a-secco.js` — sola lettura, **funzioni vere**
(`resolveMarketRules`, `resolveMarketDepth`, `decideReprice`, `scalaPerIlMotore`, `provaRinnovo`,
`valutaMercato`, `mediaProfonditaAltrui`): nessuna aritmetica ricopiata. Il controfattuale è
**esatto**, non stimato — `valutaMercato` è chiamata **due volte sugli stessi ingressi**, una con
`rinnovo: null` (che riproduce byte per byte il sorgente di ieri) e una con la prova vera.
*(`scalaPerIlMotore` è stata **esportata** apposta: ricopiarla in uno script di ricerca sarebbe il
reperto D1 dentro la misura con cui si decide. L'export non ha effetti.)*

**Mercati che hanno perso ordini nelle ultime 2 h: 7 · 18-20 ordini morti · ~$141-148.**
In quella finestra le sottocause sono: **`pavimento` 16 ($110,73)** e `meno-di-2-livelli` 1 ($25,30).

**A/B sul libro vivo (29 ordini a riposo, 15 mercati):**

| | ordini | nozionale |
|---|---|---|
| rifiutati da `profondita-insufficiente` PRIMA | 3 | $38,63 |
| di cui classe **`pavimento`** | **2** | **$9,68** |
| **recuperati dalla correzione** | **2** | **$9,68** |
| **quota della classe `pavimento` recuperata** | **2/2 = 100%** | **100%** |
| restano rifiutati | 1 | $28,95 |
| **REGRESSIONI (passava prima, rifiutato dopo)** | **0** | — |
| ordini che **non stanno rinnovando** (size o nozionale in aumento ⇒ pavimento pieno) | 3 / 29 | — |

L'unico che resta rifiutato è `0x4d79d306` YES BUY 0,516: cade su `dentro la banda c'è 1 livello`
(sottocausa non coperta) **e** non è un rinnovo — è un inseguimento che alzerebbe il nozionale da
$28,95 a $30,46. **Rifiutato a ragione, due volte.**

> ### ⚠ E IL RECUPERO SUI 39 NON È UNA SIMULAZIONE: È DETERMINATO
> Con l'esenzione il pavimento vale **0**, quindi il livello `i=1` è **sempre** ammesso dal
> pavimento; poi o passa il confronto sul prezzo, o innesca il ramo del prezzo di riferimento. In
> entrambi i casi il verdetto è **ammesso**. L'unica condizione residua è `dentro.length ≥ 2`, che il
> messaggio stesso dei 39 dimostra («…su **N** livelli», con N = `dentro.length − 1` ≥ 1).
> **Ogni rinnovo GTD è esente per costruzione**: TRIGGER 2 di `decideReprice`
> (`auto-reprice.js:613`) restituisce `targetPrice: price`, cioè **lo stesso prezzo**, quindi size e
> nozionale non salgono e `provaRinnovo` concede. ⇒ **39 su 49 (79,6%) dei rifiuti, 39 su 63 (61,9%)
> delle morti del giro, $260,66 di nozionale.** Ben oltre la metà.

---

## 6 · L'asserzione che morde (punto 8)

`lib/maker/rinnovo-sotto-il-pavimento.test.js` — **22/22 verdi**. La proprietà, testuale:
*un ordine già a libro, rinnovato a prezzo e size identici su un mercato la cui profondità è scesa
sotto la soglia d'ingresso, DEVE essere rinnovato e non rifiutato.* Nessuna asserzione guarda una
stringa del sorgente o conta occorrenze: si costruisce un book vero (pavimento $175,07 su una media
di $1.750, profondità altrui $89-118 — **sopra** il ripiego di $15) e si guarda il **verdetto**.

**Mutazioni provate una per una, e riportate per come sono andate davvero:**

| mutazione | esito |
|---|---|
| il filo tagliato (`esente` forzata a false = il sorgente fino a oggi) | **ROSSO**, 5 asserzioni (② e ②-bis) |
| `rinnovo` non inoltrato a `trovaLivello` | **ROSSO**, le stesse |
| il ramo del prezzo di riferimento disattivato | **ROSSO**, 2 asserzioni (②-bis) |
| l'allarme aggregato reso muto | **ROSSO**, 8 asserzioni in `scaduto-senza-rinnovo.test.js` |
| l'esenzione applicata **sempre** invece che al solo ritenta | **verde** — e lo dichiaro invece di tacerlo: col ramo del prezzo di riferimento al suo posto le due forme accettano esattamente le stesse configurazioni. La forma «prima senza, poi con» resta perché rende la monotonia **strutturale**, non una conseguenza da ricontrollare |

Più: **③ monotonia su 252 configurazioni** (nessuna passa prima e fallisce dopo) · **④** «mai primo»
e tetto per mercato restano applicati su un rinnovo provato · **⑤** quattro modi di non essere un
rinnovo ricevono il pavimento pieno · **⑥** `meno-di-2-livelli` resta rifiutato prima e dopo ·
**⑦** il prezzo restituito non supera mai quello dell'ordine sostituito.

**Test riscritti, non ammorbiditi:** `motore-riceve-il-book.test.js` chiedeva il veto del pavimento
su un ordine che il ciclo stava **rinnovando**, cioè difendeva la proprietà vecchia. La proprietà
che quel file esiste per difendere — «il motore riceve la scala e le Regole 2-5 girano davvero» — si
prova adesso **meglio**: il pavimento si verifica sull'INGRESSO (`rinnovo: null`), il rinnovo sullo
**stesso book** passa, e il veto del ciclo si verifica su un inseguimento al rialzo e su un doppione.
**45/45**, e rosso sul sorgente non corretto.

---

## 7 · Cosa NON è stato toccato (punto 6)

Cap **$2.400** · **18 slot** · tetto per mercato **$61,25** · distanze (lunghi/corti) · soglia **24 h**
· filtro meteo · tetto coppia **101¢** · payback · guardiano · kill R10 · la Parte B · il fix
**OFF_TICK** · soglia di abbandono **$3,0625** · GTD di chiusura **33 min** · il rifiuto dei mercati a
netto negativo. **Nessuna posizione venduta. Nessun ordine cancellato o piazzato da me.**
Verificato anche dalla suite: i **7 rossi noti** sono rimasti **7**, per nome.

---

## 8 · Altri difetti trovati — dichiarati e NON corretti (punto 11)

1. **🟡 `scripts/dipendenze-scollegate.js` non vede questa classe di filo tagliato.** Cerca le
   `deps.*` facoltative mai iniettate; `rinnovo` è un **argomento nominato** passato fra due moduli,
   e il rilevatore non lo guarda. Ha risposto «0 facoltative mai iniettate in moduli VIVI» mentre il
   filo era morto da sette giorni. La cura sarebbe un rilevatore che confronti le chiavi passate a un
   chiamato con quelle che il chiamato destruttura. **Non fatta**: è un secondo lavoro, e tocca lo
   strumento con cui si misura.
2. **🟡 Il `gate` originale del rinnovo si perde nell'audit.** `auto-reprice.js:1751` sovrascrive
   `d.gate` con `motore-non-conforme`, quindi la riga non dice più se il rinnovo veniva da
   `expiry-refresh` o da un inseguimento. Per contare i 49 ho dovuto dedurlo dal testo del `reason`.
   È la stessa famiglia di §5.2 p.59 («un motivo che non si scrive è un motivo che non esiste il
   giorno dopo»). **Non corretto**: cambia la forma del giornale, che altri lettori confrontano.
3. **🟡 `provaRinnovo` condizione ③ è sbagliata di verso su una gamba SELL.** «Il nozionale non
   aumenta» è il conto di chi **compra**: su una SELL un prezzo più alto è meno probabile che venga
   riempito, cioè **meno** rischio, non più. Oggi il modulo lo tratta come apertura e **nega**
   l'esenzione — cioè sbaglia nella direzione prudente, e per questo non l'ho toccato. **Serve una
   decisione**, non una patch.
4. **🟡 `lib/maker/quantita-davanti.js` continua a non avere chiamanti** (§5.2 p.52). Non toccato.

---

## In sei righe

1. **La causa dei 49**: il **pavimento di profondità** (`motore-unico.js:426`,
   `DEPTH_FLOOR_PCT_OF_AVG = 0,10`), e **tutti e 49** sono suoi — 39 `banda finisce prima del
   pavimento`, 8 `banda non calcolabile`, 2 `un solo livello`. L'esenzione per i rinnovi esisteva dal
   16 agosto ed **era inerte**: `valutaMercato` non destrutturava `rinnovo` e non lo inoltrava a
   `trovaLivello` (`motore-unico.js:378-379` e `:422-423` del sorgente di ieri). Sesta occorrenza
   della classe «dep col nome giusto che nessuno inietta», questa volta col filo tagliato in mezzo.
2. **Cosa ho esentato**: il **solo** pavimento di profondità, e **solo** su un ordine di cui
   `esenzione-rinnovo` **dimostra** contro gli ordini vivi del venue che sostituisce una gamba a
   libro senza far salire né size né nozionale — sul prezzo che **parte davvero**, non su quello
   vecchio. Perché il pavimento limita l'**apertura**, e un rinnovo non apre: l'alternativa non è
   «meno esposizione», è «la gamba muore e restiamo direzionali». Mai-primo, tetto per mercato,
   banda, fine scala, KILL, rate limit e tetto per ordine restano identici e asseriti.
3. **Mercati davvero illiquidi: ZERO su 10.** Mediana della profondità altrui davanti **$106,50**,
   cioè **7×** il ripiego di $15 che il motore chiede a un mercato senza storico; Bad Bunny aveva
   **$543,75** davanti. Nessuno slot da liberare, e nessun meccanismo aggiunto per farlo.
4. **Nozionale che torna a libro**: **$260,66** sui 39 del giro di stamattina (**79,6%** dei rifiuti
   `motore-non-conforme`, **61,9%** di tutte le morti) — determinato, non stimato, perché con
   pavimento 0 il livello `i=1` è sempre ammesso e ogni rinnovo GTD è esente per costruzione. Sul
   libro vivo, A/B a secco: **classe `pavimento` recuperata al 100%, zero regressioni**.
5. **Capitale al lavoro dopo due cicli**: in coda a questo file, § *Dopo due cicli*.
6. **La suite: 256 test · 248 verdi · 7 ROSSI · 1 non parte** — i sette noti e nient'altro
   (`dipendenze-mai-iniettate`, `distanza-2c`, `end-of-scale-cycle`, `tetti-per-giro-e-scope`,
   `categoria-mercato`, `tetto-derivato-dallo-scaglione`, `tetto-e-scoperta`).

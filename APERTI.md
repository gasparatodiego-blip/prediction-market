# Cosa resta aperto — aggiornato il 17 agosto 2026, sera

Scritto perché una sessione nuova possa riprendere **senza rileggere tutto**. In ordine di quanto
costa se non si ripara. Lo stato del sistema al momento della chiusura è in fondo.

---

## IL QUADRO — dove siamo, in tre numeri

| | |
|---|---|
| **passi del giro completo che arrivano in fondo** | **18 su 18** (i 17 + il 15-bis) — nessuno bloccato, nessuno annotato |
| **regole che scattano** | **21 statiche + 16 dinamiche su 91**, col cablaggio di produzione |
| **regole rosse perché il pezzo NON ESISTE** | **ZERO**, e non è un'ipotesi: misurato cercando i chiamanti |
| **determinismo** | **10 corse su 10**, una firma sola (`61f5582e56f75903`) — riprovato DOPO il riavvio |
| **cinture che mordono davvero** | **2 su 5**: `MANUAL_ORDER_PLACEMENT` + il freno di agent41. Le altre tre sono inerti sul percorso che piazza — vedi «LA SEQUENZA DI ARMAMENTO» |

⚠ **Il conteggio è SCESO da 22+17 a 21+16, ed è la conseguenza voluta della cura del passo 13**: sparisce
`reject-nozionale-mercato-oltre-tetto` (non c'è più il rifiuto) e sparisce `partial` di `bulk-allocate` (non
c'è più un bulk parzialmente rifiutato). Meno regole esercitate perché ci sono meno rifiuti da esercitare —
non una copertura peggiore.

⚠ **Il vecchio «37 su 91» è stato buttato**, e va ricordato perché: quel banco non chiamava
`agent40.closeTask()` — ricablava `runAutoCloseCycle` da sé, con **17 dep contro le 20** che la
produzione passa. Misurava un auto-close che questo bot non ha.

---

## 0 · IL BANCO DEL CICLO COMPLETO — `banco-scenari.js`

`node scripts/ricerca/banco-scenari.js` fa girare **il bot vero col SUO cablaggio** contro un venue
simulato. Esce **1** se un passo non arriva in fondo, e dice quale.

**Chiama le porte di produzione**, non le sue: `A41.giro()` · `A41.controlloCapitaleFermo()` ·
`A40.cycle()` · `A40.closeTask()` · `A40.snapshotPosizioniTask()` · `A40.sorveglianzaTask()` ·
`A40.sparizioneTask()` · `A43.poll()`. Un test lo asserisce **per assenza**: `runAutoCloseCycle(` e
`runReallocCycle(` non compaiono nel banco (`lib/maker/cablaggio-di-produzione.test.js`).

**Dove gira**: worktree `/root/bot-banco`, con `data/` **copiato**. Il banco **verifica `diff -rq` su
`lib/ agents/ scripts/`** contro `/root/bot` e **si rifiuta di partire se differiscono** — non è una
promessa, è un cancello. `data/` non è dirottabile (`store.js:32` risolve sul package root, senza env) e
agent41 ci scrive piano, tetti, allowlist, selezione, giornale. Le credenziali non esistono nel worktree.

```bash
git worktree add -f /root/bot-banco HEAD && ln -sfn /root/bot/node_modules /root/bot-banco/node_modules
rsync -a --exclude 'mid-history-*.jsonl' --exclude 'ricerca/' --exclude 'history/' /root/bot/data/ /root/bot-banco/data/
cd /root/bot-banco && node scripts/ricerca/banco-scenari.js
```

### Il venue ha SEI porte, e una sola era configurabile

Ogni blocco del banco ha scoperto una porta che il seam non copriva:

| # | porta | cosa è |
|---|---|---|
| 1 | `venues/polymarket-clob-maker/adapter` | gli **ordini** |
| 2 | `venues/polymarket-clob/adapter` | **legge e cancella**, ed è un modulo DIVERSO (`manual-order.js:58`) |
| 3 | `maker/saldo-cache` | il **denaro**, via RPC on-chain |
| 4 | `maker/ctf-relayer` | la **catena**. ⚠ senza, `auto-close.js:676` firma un merge VERO |
| 5 | CLOB REST via **`POLY_CLOB_BASE`** | la sola già configurabile: il banco alza un server su 127.0.0.1 |
| 6 | `maker/manual-reset.fetchVenuePositions` | le **posizioni** via data-api (`DATA_API` letterale in 4 moduli) |

⚠ **L'ordine delle sostituzioni è parte del seam**: il blocco della 6 fa `require('manual-reset')`, che
tira dentro `manual-order`, che a `:58` **destruttura** l'adapter di cancellazione al caricamento.

### È DETERMINISTICO: 10 corse, una firma sola

`node scripts/ricerca/prova-determinismo-banco.js` → **10/10**. Le fonti di caso erano **quattro**:
`Date.now` · **`new Date()` senza argomenti** (12 occorrenze nel solo agent41, e non passa da `Date.now`)
· **`Math.random`** (jitter del backoff) · **lo stato del riprezzo che sopravviveva fra le corse**
(`recentAt`, `lastRepriceAt`). Il passo 1 azzera **dieci** file di stato per corsa.
⚠ L'istante zero è **l'ora vera arrotondata al minuto**, non un istante fisso: il piano nasce in un
processo figlio (`RUNNER_PIANO`) che ha il suo `Date.now` e legge lo storico coi tempi veri. Un istante
lontano farebbe sembrare al figlio che lo storico seminato dal banco sia nel futuro.

---

## 1 · 🟢 CHIUSO — IL PASSO 13 RICOSTRUISCE LA COPPIA, NON LA GAMBA

**Il passo 13 arriva in fondo**, e il criterio non è più «il lato è tornato a libro» (che si accontentava
di un ripristino asimmetrico, cioè dello stato che sfondava il tetto) ma **tre cose insieme**:

```
lati dopo il ripristino : {yes:1, no:1}
coppia                  : 61,2 × $0,32  +  61,2 × $0,64  =  $58,75   ≤  $61,25
simmetrica              : sì (le due size coincidono)
la gamba viva è SCESA   : 87,5 → 61,2   (prima si riduce, poi si piazza)
```

**⚠ LA MIA DIAGNOSI PRECEDENTE ERA SBAGLIATA, e va detto perché cambiava la cura.** Qui c'era scritto «il
riprezzo ricalcola la size della gamba viva»: **non lo fa** — `auto-reprice` passa `size: order.size` a
`replaceManualOrder`, in undici punti, verificato. La causa vera è più semplice e più generale:
`gambeDiUnaRiga` calcola `Q = capitale/(p_yes + p_no)`, cioè due gambe simmetriche **nell'istante in cui le
costruisce**; la gamba superstite porta addosso la size dell'istante in cui *fu piazzata*, e quando il mid
si muove `p_yes + p_no` cambia. 87,5 e 62,2 sono la **stessa formula a due istanti diversi** (la coppia
costava $0,675 allora e $0,95 adesso). Nessuno riportava la gamba viva alla size di oggi.

**La cura** (`lib/maker/coppia-simmetrica.js`, puro): una sola funzione decide la size di **entrambe**,
`Q = min(Q_piano, Q_tetto, Q_gamba_viva)`, e ognuno dei tre vincoli può solo **ridurre**.
- **`Q_gamba_viva`** rende il modulo **monotono**: la gamba viva si può solo rimpicciolire. Far crescere un
  ordine a riposo per «pareggiare» sarebbe aggiungere esposizione per ragioni di simmetria.
- **`Q_tetto`** si calcola sui prezzi **veri** di ciò che resterà a libro (quello dell'ordine vivo per chi
  sopravvive, quello del piano per chi nasce): col prezzo di piano per entrambe si proporrebbe un totale
  che poi il gate rifiuterebbe.
- **sotto il minimo premiante non si ricostruisce**, e il tetto **non** si allarga: è l'unico esito in cui
  il modulo dice «no» invece di dire «più piccolo».

**L'ordine delle due azioni è parte della cura**: `nozionale-mercato-oltre-tetto` somma il nozionale a
riposo, quindi **prima si riduce, poi si piazza** — e se la riduzione fallisce **non si piazza**, perché due
gambe asimmetriche sono peggio di una gamba sola. Il tetto **non è stato toccato**: resta $61,25.

**Il tetto che sarebbe servito, e che non è stato usato** (`tetto-per-ricostruire-la-coppia.js`): $83,13
(1,36×) per quella coppia, fino a **$641,36 (10,47×)** nel caso peggiore sul board. Restano a verbale come
misura del costo di *non* fare la cura, non come proposta.

**Prove**: `coppia-simmetrica.js` selfcheck **30 asserzioni** (monotonia su 100 size, invariante del tetto
su 425 combinazioni) · `coppia-simmetrica-scatta.test.js` **21 asserzioni** sul CABLAGGIO, attraverso
`agent41.ripristinaGamba` vera, con la sequenza delle chiamate misurata · banco passo 13 verde, **10 corse
su 10** con la stessa firma.

**⚠ Due regole del banco non scattano più, ed è la conseguenza voluta**: `reject-nozionale-mercato-oltre-tetto`
(non c'è più il rifiuto) e `partial` di `bulk-allocate` (non c'è più un bulk parzialmente rifiutato). Il
conteggio scende da 22+17 a **21+16**: meno regole esercitate perché ci sono meno rifiuti da esercitare.

---

## 2 · 🟢 CHIUSO — `carico-di-ripiego` ARRIVA AL SECONDO LIVELLO

`deps.ultimoNostroPrezzo` non era cablata — **settima** occorrenza di «dep non cablata ⇒ valore di difetto
che nessuno ha chiesto». Ora `closeTask` la passa, e il prezzo viene dal **giornale**
(`lib/maker/ultimo-nostro-prezzo.js`, lettura incrementale) e non dalla memoria di processo: un carico che
sparisce al riavvio è un'uscita che sparisce al riavvio.

Contano solo gli invii **accettati** (`outcome: 'sent'`) e solo i **BUY**. Per poterlo fare,
`manual-replace` ha ricevuto il campo **`side`** nel proprio record: senza, un rimpiazzo era
indistinguibile fra acquisto e vendita, e **un record senza `side` viene saltato** invece di essere
interpretato.

**La prova è nel giro** (passo **15-bis**, fill TOTALE, `avgPrice` nascosto): il giornale porta
`carico-di-ripiego` con **`fonte: 'ultimo-ordine-nostro'`** e carico **$0,38**, che è il prezzo davvero
mandato al venue — e il modulo interrogato da fuori dà lo stesso numero. ⚠ Non basta che esca
`carico-di-ripiego`: il passo 15 lo produce già col primo livello, quindi si pretende **la fonte**.

**⚠ E lo scenario del banco si accende PRIMA del fill**: `VENUE.riempi` fotografa
`avgPriceNascostoPerCicli` nel momento in cui crea la posizione, quindi accenderlo dopo non nasconde
niente. La prima stesura del passo dichiarava rossa una difesa cablata.

---

## 3 · 🟢 CHIUSO — `stato.js` LEGGE LE CINTURE DAI PROCESSI VIVI

`lib/maker/cinture-armamento.js` (puro) risponde sullo stato delle cinque cinture **per un ambiente
qualunque**, e `stato.js` gli passa `/proc/<pid>/environ` dei processi che decidono un prezzo. Il `.env`
si mostra ancora, ma dichiarato per quello che è: **cosa entrerebbe al prossimo riavvio dal file**, con la
divergenza segnalata. E se due processi portano cinture diverse, lo dice in rosso.

Perché un modulo e non un `if`: `stato.js` non può importare `manual-order` né l'adapter — il suo
§PERIMETRO cammina `require.cache` e cade se ha caricato una superficie che sa piazzare. Verificato: il
perimetro resta pulito.

**Due delle cinque sono importate davvero** — il freno di agent41 da `freno-prova.statoFreno`, e
`MANUAL_ORDER_PLACEMENT` è definita nel modulo nuovo e `manual-order` la **importa** (stessa funzione, non
una copia). **Le altre tre sono uno specchio dell'adapter, e lo specchio è provato**:
`cinture-armamento.test.js` (24 asserzioni) importa l'adapter vero e confronta i verdetti.

**Lo specchio ha trovato due divergenze mie, nella direzione che costa**: normalizzavo `MAKER_MODE` con
`trim().toLowerCase()`, quindi su `'LIVE'` o `'live '` dichiaravo la cintura **APERTA** mentre
`config.loadMakerConfig` risolve quei valori a `off` (cintura inserita); e leggevo `MAKER_ADAPTER_DRYRUN`
insensibile alle maiuscole, quindi su `'TRUE'` l'avrei dichiarata **inserita** mentre `envBool` fa
`v === 'true'` — cioè avrei dichiarato sicura una configurazione che non lo è. **Uno specchio deve essere
esatto, non ragionevole.**

Terza scoperta, dallo stesso confronto: `evaluatePlacementGate` ha gate che **non** sono cinture
dell'operatore (`kill`, `venue-allowlist`, `limit-*`, `v2-sdk-*`, `funding-approval`). Quindi
`puoPiazzare` dice che **le cinque sono aperte**, non che l'ordine passerebbe — ed è scritto nel modulo.

---

## 4 · 🟢 CHIUSO — I RESIDUI SOTTO IL MINIMO: QUANTO, E CHE COSA SI PUÒ FARE

`scripts/ricerca/residui-sotto-il-minimo.js`, sul board vero (144 mercati, 37 raggiungibili).

**Il caso peggiore su UN mercato**: `(minSize − 0,01) × prezzo_del_lato_caro`, con il tetto per ordine
($65,63) e quello per mercato ($61,25) sopra.

| minSize | caso peggiore | |
|---|---|---|
| 20 | **$19,44** | 19,99 × $0,9725 |
| 50 | **$46,79** | 49,99 × $0,936 |
| 100 · 200 | $61,25 | il pavimento premiante li esclude: **il bot non entra** |

⇒ **sui mercati che il bot può davvero aprire il peggio è $46,79 su un mercato solo**, e il peggiore
misurato in concreto è $45,24 («Will 1 Fed rate cut happen in 2026?», minSize 50). **Bloccato adesso:
$3,00** — i 6 share di Hong Kong.

**⚠ Si conta su UN LATO SOLO, e non è una semplificazione**: un residuo su *entrambi* i lati è una coppia
parziale, e una coppia si **fonde on-chain** — `mergePosition` non ha minimi di size. Quel caso non è
bloccato.

**Che cosa si può fare davvero** — verificato sul codice, non proposto:

| strada | minimo di size | cablata | limite |
|---|---|---|---|
| **riscatto on-chain dopo la risoluzione** | **nessuno** | **sì** (agent40 → `riscatto-automatico`) | rende $1/share al lato vincente, $0 al perdente |
| merge della coppia | nessuno | sì | inapplicabile: il residuo sta su un lato solo |
| vendere a libro | minSize del venue | sì | **è la strada chiusa**: il venue rifiuta |
| accumulare fino al minimo | minSize | sì | serve un ALTRO fill sullo stesso lato: è un'attesa, non un'uscita |

**La risposta, quindi: la via d'uscita esiste già e non passa dal libro.** Il riscatto automatico non ha
minimi di size, ed è cablato dal 17 agosto (§5 p.131). Il costo vero **non è il capitale — è il tempo**: al
massimo $46,79 per mercato immobilizzati fino alla risoluzione, più il rischio direzionale su una gamba
nuda che può valere $0. Ciò che *resta* aperto non è una via d'uscita mancante: è che il residuo nasca —
e questo si riduce solo non facendo fill parziali, cioè con size più piccole o mercati più profondi.
**Non c'è niente da implementare qui**, e per questo il punto scende dal 🔴 al 🟢.


## 5 · `git push` bloccato — 70 commit solo locali

Il remote è HTTPS e in `~/.ssh` c'è solo `authorized_keys`. Serve **una** delle due, e nessuna la può fare
un agente: una chiave SSH (`ssh-keygen -t ed25519`, pubblica su GitHub, `git remote set-url origin git@…`)
oppure un PAT con scope `repo` in `~/.git-credentials`. **Riprovato il 17 agosto sera**:
`fatal: could not read Username for 'https://github.com'`. **69 commit** davanti a `origin/main` al momento
della verifica, il settantesimo è quello del quadro.

---

## 6 · 🟡 `npm run build` FALLISCE: manca `lucide-react`

Causa preesistente: `app/components/ui/Redacted.tsx` lo importa e non è in `package.json`. Il build stampa
`✓ Compiled successfully` e muore **dopo**, nel type-check: tutto il JS compila. Su questa copia il
`dashboard` non è nella flotta, quindi non serve a nessun processo vivo. Verifica al suo posto:
`suite-rossi.js` e i 5 selfcheck.

---

## 7 · 🟡 CHE IL RESIDUO NASCA — quello che resta davvero aperto

Il punto **4** chiude la domanda «che cosa si può fare»: la via d'uscita esiste (riscatto on-chain, nessun
minimo di size) e il caso peggiore su un mercato è **$46,79**. Quello che resta aperto è a monte: **evitare
che il residuo nasca**, cioè non prendere fill parziali che lascino meno di `min_incentive_size`. Le leve
sono la size (più piccola ⇒ più mercati) e la profondità del mercato, non un meccanismo nuovo di uscita.
Nessuna misura, nessuna decisione chiesta: è la voce da cui ripartire se un giorno i residui diventassero
molti invece di uno.

---

## LE 70 REGOLE CHE NON SCATTANO, DIVISE PER CAUSA

`node scripts/ricerca/perche-non-scattano.js` — e le due categorie chiedono cose diverse:

⚠ **Erano 69 e sono 70**: la cura del passo 13 ha *togliato* `reject-nozionale-mercato-oltre-tetto` e
`partial` dai rifiuti esercitati, e il passo 15-bis ha *aggiunto* `carico-di-ripiego` al secondo livello (già
contato fra le scattate come esito). La spartizione fra A e B non cambia.

### A · IL GIRO NON CI È ARRIVATO — **66**

**39 dei passi 8-17** (il pezzo c'è, ha un chiamante, serve uno scenario):

| passo | regole | passo | regole |
|---|---|---|---|
| 16 · ciclo di vita del mercato | **18** | 10 · scala d'urgenza | 2 |
| 17 · interruttori e limiti | 6 | 8 · rotazione dello slot | 1 |
| 9 · residui e fill parziale | 5 | 14 · sparizioni | 1 |
| 12 · merge | 5 | 15 · feed e cecità | 1 |

**26 eventi che il venue simulato non sa fare**: 429, `Retry-After`, riconnessioni del websocket, dati
malformati, esiti ambigui.

### B · NON PUÒ SCATTARE — **4**, e sono difese, non buchi

| regola | file:riga | perché |
|---|---|---|
| **nessuna** | — | **ZERO regole rosse perché il pezzo non esiste** — misurato: per tutte e 70 il chiamante c'è |
| `skip-cancel-non-collegato` | `lib/maker/auto-reprice.js:1830` | scatta solo se `deps.cancelOrder` non è una funzione: sarebbe un difetto NOSTRO |
| `merge-esito-mancante` | `lib/maker/auto-close.js:1999` | il rilevatore dell'obbligo di esito rimasto aperto, idem |
| `dry-run-validated` | `lib/maker/auto-close.js:2718` | ramo della modalità dry-run, e il banco invia sempre |
| `exit-market-dry-run` | `lib/maker/auto-close.js:2518` | idem |

⚠ **La parte debole è dichiarata**: A e B sono solidi (B1 è misurato camminando i chiamanti in tutto `lib/`
e `agents/`); la spartizione *dentro* A — «passi 8-17» contro «eventi esterni» — resta una classificazione
per famiglia di parole. Ogni voce del referto porta `file:riga`.

---

## I DIFETTI CHIUSI OGGI, COI COMMIT

| difetto | commit |
|---|---|
| il perno `MAKER_LIVE_MIN_MARKET` **aggiungeva** un'entrata invece di restringere | `14b662d` |
| i due presidi di agent40 dipendevano dagli avanzi della fase precedente | `b55b199` |
| le sei fixture del banco: provate per sottrazione — 18 regole su 20 dipendevano da una sola | `84bf188` |
| `giro()` non era raggiungibile; i due file del feed erano letterali in cinque moduli | `0897e64` |
| il banco ricablava `runAutoCloseCycle` con 17 dep contro 20 | `226471b` |
| **il kill a −$100 non cancellava**: era un gate di piazzamento con il nome di un kill | `e838c82` |
| il piano salvato sopravviveva a un cambio di selezione fino a 60 minuti | `3e9b549` |
| la scadenza non toglieva il mercato dal perimetro senza aspettare il ciclo da 6 h | `3e9b549` |
| su fill parziale il residuo moriva nello stato **meno** esposto, e la condizione era una tautologia | `3eccec2` |
| il banco non era deterministico: quattro fonti di caso, tre orologi e un avanzo | `aeaa183` |
| §5.2 p.38: il gate del nozionale mancava dai precontrolli del riprezzo | `e3dcfb0` |
| `ripristino-gamba \| rifiutata` non diceva quale gate l'aveva rifiutata | `e3dcfb0` |
| **tre difese INERTI** (sotto) | `e3dcfb0` |
| il quadro, e le 69 regole divise per causa | `8f8b77c` · `25ee064` |
| **il passo 13**: due funzioni dimensionavano la stessa coppia in due istanti diversi ⇒ asimmetria ⇒ sforo | *(questo commit)* |
| `carico-di-ripiego`: il secondo livello non aveva chi gli passasse `ultimoNostroPrezzo` — **settima** «dep non cablata» | *(questo commit)* |
| `manual-replace` non scriveva `side`: il giornale non distingueva un rimpiazzo BUY da uno SELL | *(questo commit)* |
| `stato.js` leggeva le cinture dal `.env` invece che da `/proc`, e mi aveva già mentito una volta | *(questo commit)* |
| lo specchio delle cinture normalizzava `MAKER_MODE`/`DRYRUN` e divergeva dall'adapter su `'LIVE'` e `'TRUE'` | *(questo commit)* |

**Le tre difese inerti, e sono la lezione della giornata:**

| | cosa leggeva | conseguenza |
|---|---|---|
| il kill a −$100 | `lim.maxDailyLossUsd`, ma `resolveLimits` risponde `{ok, limits:{…}}` | soglia `undefined` ⇒ **non scattava mai** |
| il rilascio per scadenza | `p.ids`, ma `posizioniPerSelezione` restituisce `conditionIds` | «posizioni non leggibili» ⇒ **nessun rilascio mai**, dichiarandosi prudente |
| `scadenzaDalBoard` | `BOARD_NORMALIZZATO` letterale, ultimo su cinque lettori | leggeva un file diverso da tutti gli altri |

⚠ **Erano tutte e tre mie, scritte ieri e oggi, e le ha trovate il banco — non la rilettura.** Stessa
classe ogni volta: **il test provava la DECISIONE e non il CABLAGGIO**, perché iniettava una fixture di
forma **inventata** invece di copiare quella vera. È la cosa più costosa imparata oggi, e vale per il
prossimo che scrive un presidio qui dentro.

---

## PER DOMANI ① · I CINQUE MIGLIORI OLTRE 7 GIORNI — e la risposta è che non ne vale la pena

`node scripts/ricerca/domani-i-cinque-e-il-conto.js` · board del 17/08 17:02Z, 145 righe, capitale **$147**,
tetto per mercato **$61,25**. Il netto/giorno viene da `allocator.planFromCollection`, cioè dal
**pianificatore vero** girato a $147 — non da una mia formula.

**Candidabili con scadenza oltre 7 giorni: 5 su 145.** L'imbuto, misurato:

| tagliati da | quanti |
|---|---|
| pavimento premiante > tetto (`minSize` 100/200/1000) | **51** |
| la SELEZIONE — scadenza < 24 h **50** · meteo **12** · scadenza non determinabile **1** | **63** |
| orizzonte ≤ 7 giorni | **26** |
| ⇒ restano | **5** |

| # | netto/g | lordo/g | quota del montepremi | concorrenza (share in banda) | profondità altrui | montepremi | minSize | pavimento | giorni | mercato |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **−$0,00** | $0,00 | 0,0020 % | 147.564 | $309.398 | $116/g | 50 | $61,25 | 135,3 | Will no Fed rate cuts happen in 2026? |
| 2 | −$0,01 | $0,00 | 0,0045 % | 66.849 | $114.336 | $70/g | 50 | $61,25 | 812,3 | Will J.D. Vance win the 2028 R nomination? |
| 3 | −$0,06 | $0,00 | 0,0091 % | 32.913 | $60.650 | $132/g | 50 | $61,25 | 74,3 | Will Harry Kane win the 2026 Ballon d'Or? |
| 4 | −$0,15 | $0,00 | 0,0035 % | 88.408 | $24.295 | $66/g | 50 | $61,25 | 135,3 | Will 1 Fed rate cut happen in 2026? |
| 5 | −$0,67 | $0,00 | 0,0781 % | 3.846 | $13.398 | $100/g | 20 | $24,50 | 7,3 | Will N'Kiyla Thomas be the D nominee for … |

**Il capitale minimo per superare il pavimento premiante È il pavimento**, per definizione
(`minSize × 0,98 × 1,25`): **$24,50** a minSize 20, **$61,25** a minSize 50. Con $147 il tetto per mercato
li copre entrambi — non è il capitale a mancare.

> **🔴 LA RISPOSTA VERA, E NON È LA CLASSIFICA: OLTRE 7 GIORNI NON C'È NIENTE DA QUOTARE A $147.**
> Tutti e cinque hanno **lordo $0,00/g** e quota del montepremi fra lo **0,002 %** e lo **0,078 %**: le
> nostre ~62 share si dividono il premio contro **3.846–147.564** share altrui in banda. Il netto è
> leggermente **negativo** perché resta il costo del fill avverso: si pagherebbe per stare a libro.
> **Il lordo accanto al netto è obbligatorio proprio qui**: un netto negativo da solo non dice se il
> problema è il reward o il costo, e sono due cure diverse. Qui è il reward: è zero.

**Dove sta invece il valore, misurato sullo stesso board** — fra i **31** ammissibili alla selezione a
QUALUNQUE orizzonte, **11 hanno netto positivo**, e stanno tutti a **~1,3 giorni**:

| netto/g | lordo/g | giorni | minSize | concorrenza | mercato |
|---|---|---|---|---|---|
| **$60,00** | $100,00 | 1,3 | 20 | **0** | Will Sydney Gruters be the FL-16 R nominee? |
| $4,51 | $9,40 | 1,3 | 50 | 649 | Will Eric Yonce be the FL-06 D nominee? |
| $3,46 | $6,63 | 1,3 | 50 | 622 | Will James Fishback win 10–15 % of votes? |
| $1,75 | $2,86 | 1,3 | 50 | 2.230 | Will Cory Mills be the FL-07 R nominee? |
| $1,69 | $2,76 | 1,3 | 50 | 1.938 | Will Steve Friess be the WY-AL R nominee? |

Il primo è il caso «**soli sul lato**» di §4.1 (concorrenza **zero** ⇒ bordo esterno della banda, fill
improbabile, reward pieno): $100/g di montepremi, quota ~intera. **⚠ Concorrenza zero è anche il segnale
che nessuno lo vuole**: è il mercato con il rapporto rischio/beneficio più alto del board e quello dove una
notizia muove il mid senza che ci sia un libro contro cui uscire. Non è una raccomandazione, è dove sta il
numero.

**⚠ E il pianificatore, lasciato libero, sceglie altro**: le 3 righe che apre a $147 sono **meteo a 0,78
giorni** ($50,24 + $33,07 + $0,00 = **$83,31/g**), e la selezione le **esclude due volte** — famiglia meteo
e scadenza sotto le 24 h. La differenza fra $83/g e ~$0/g è **interamente** il costo dei due vincoli della
selezione, non una proprietà del mercato. È la decisione che sta sul tavolo per domani, e non la prendo io.

**⚠ Un difetto del mio primo conto, dichiarato**: avevo filtrato l'orizzonte su `candidate.horizon`, che
sul board di stasera è `undefined` per **31 candidati su 145** (`horizonUnknown`) — e la risposta usciva
«**zero** candidabili oltre 7 giorni». È un `Number(null)` travestito da misura (§5.3). La scadenza vera sta
sul board, ancorata al **venue** (§4.7), ed è la stessa che la selezione ha appena usato per ammettere.

---

## PER DOMANI ② · IL CONTO SU UN MERCATO SOLO, IN CHIARO

> **⚠ IL TETTO PER MERCATO MORDE PRIMA DEL CAPITALE: su un mercato solo NON entrano $147.**
> Il tetto è **$61,25** e non è una manopola — deriva dal pavimento premiante dello scaglione finanziabile
> (§4.2). «$147 su un mercato» non è una configurazione che il bot possa produrre.

Mercato: **«Will no Fed rate cuts happen in 2026?»** · mid **0,8515** · banda **±4,5¢** (`max_spread` 4,5¢)
· tick **0,001** · `minSize` **50** · pavimento premiante **$61,25**.

**Quello che il bot fa davvero:**

```
capitale sul mercato      = min($147, tetto $61,25)            = $61,25
costo della coppia        = p_yes + p_no ai prezzi di quotazione = $0,98
share per lato        Q   = $61,25 / $0,98                     = 62,5 share
capitale impegnato        = 62,5 × $0,98                       = $61,25
supera il pavimento?      62,5 share ≥ minSize 50              = SÌ, margine 12,5 share
capitale che RESTA liquido = $147 − $61,25                     = $85,75
```

**A che distanza dal mid** (letto da `/proc/270521`, non dal `.env`):

```
manopola   MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V = 0,95   ⇒ obiettivo 0,95 × 4,5¢ = 4,27¢ dal mid
margine    max(1 tick, 0,22 × v) = 10 tick su tick 0,001 ⇒ bordi [0,8165 · 0,8865] invece di [0,8065 · 0,8965]
⇒ distanza finale dal mid: 3,5¢  su una banda di ±4,5¢   (S ≈ 0,05, venti volte il bordo nudo)
```

**⚠ Gli $85,75 che restano liquidi non sono un residuo aritmetico**: sono la ragione per cui «un mercato
solo» e «$147 al lavoro» sono due obiettivi incompatibili. Per far lavorare tutto il capitale servono **tre**
mercati ($61,25 × 3 = $183,75 > $147, quindi tre parziali) — ed è esattamente ciò che la selezione a tre
slot è disegnata per fare. Su un mercato solo il **58 %** del capitale sta fermo per costruzione.

**⚠ E su QUESTO mercato il reward è ~zero** (tabella ①: quota 0,002 %). Il conto sopra dice che l'ordine è
*valido*, non che *rende*. Le due domande sono diverse e vanno tenute diverse.

---

## LA SEQUENZA DI ARMAMENTO — scritta, NON eseguita

> **🔴 PRIMA DI TUTTO, UNA COSA CHE CAMBIA LA SEQUENZA E CHE NON SAPEVAMO: DELLE CINQUE CINTURE, SULLA
> STRADA DA CUI IL BOT PIAZZA NE MORDE UNA.**
> Verificato per grep e per esecuzione del gate, non per lettura di commenti:
> - **`createMakerAdapter` ha UN SOLO chiamante in tutto il repo**: `lib/maker/manual-order.js:774`.
>   Ogni piazzamento passa da lì — `runBulkAllocation` è «un ciclo su `placeManualOrder`, nient'altro»
>   (`bulk-allocate.js:4`), quindi anche agent41 arriva alla stessa porta.
> - quel chiamante **cabla `mode: 'live-min'` a mano** (`manual-order.js:775`) ⇒ **`MAKER_MODE` non
>   gate la corsia manuale**: il valore `off` che leggiamo su `/proc` non la ferma.
> - quel chiamante **non passa `dryRun`** (`manual-order.js:1456-1462`), e l'adapter fa
>   `dryRun = opts.dryRun === true` (`adapter.js:456`) ⇒ **`MAKER_ADAPTER_DRYRUN` non viene letta**.
> - **`MAKER_PLACEMENT` non è usata** su questo percorso: il `placement` arriva da
>   `manualPlacement()`, cioè da `MANUAL_ORDER_PLACEMENT`.
> - `loadMakerConfig` (che leggerebbe `MAKER_MODE`+`MAKER_ADAPTER_DRYRUN` e calcola `canWrite`) **non ha
>   chiamanti** fuori dai commenti.
>
> **Prova eseguita**: con i valori esatti che `buildPlacementAdapter` produce —
> `evaluatePlacementGate({mode:'live-min', dryRun:false, fundingApproved:true, sdk})` → **`allow: true`**.
> Il solo `if` fra quel verdetto e la POST è `adapter.js:923`: `if (placement !== 'send')` ⇒
> `dry-run-validated`.
>
> **⇒ Il bot oggi è fermo per DUE presidi, non cinque**: `MANUAL_ORDER_PLACEMENT=dry-run` su agent40 e il
> **freno di agent41** (`REALLOC_SCHEDULER_DRY_RUN` assente ⇒ inserito, fail-closed). Le altre tre sono
> **inerti su ogni percorso di piazzamento che esiste oggi** — non sono un danno, ma contarle come cinture
> indipendenti sovrastima la difesa di un fattore due e mezzo. **Non le ho toccate**: renderle efficaci
> significa passarle a `buildPlacementAdapter`, cioè modificare il percorso che piazza, e va fatto con la
> sua misura e la sua decisione.

### Le precondizioni — nessuna di queste è una cintura, e tutte vanno vere PRIMA

| # | cosa | come si verifica |
|---|---|---|
| P1 | il mercato del giro è scelto e la sua riga di piano esiste | `node scripts/cli/mercati.js` · `data/realloc-ultimo-piano.json` contiene quel `marketId` |
| P2 | **il perno** `MAKER_LIVE_MIN_MARKET=<conditionId>` è in `agents/ecosystem.config.js` | riavvio **dal file e insieme**, poi `node scripts/cli/mercati.js` deve dire **1 mercato ed è quello** su ENTRAMBI i processi |
| P3 | KILL spento · **AVVIA** (oggi è FERMA) · interruttore riprezzo acceso | `node scripts/cli/stato.js` |
| P4 | i limiti sono quelli decisi | per ordine $80 · esposizione $150 · perdita giornaliera $100 · 40 invii/60 s |
| P5 | il saldo copre il piano | il tetto per mercato si clampa al capitale: sotto $61,25 il piano si stringe da sé |

⚠ **P2 è la più importante e la più facile da sbagliare**: senza perno il perimetro è *una conseguenza*
dell'unione di §4.8 (oggi vale 1 perché esiste una posizione residua) e **cambia da sé** quando quella
posizione si chiude. Con il perno è **stabile e nominato**. E il perno **restringe**: un mercato con
posizione non riceve più il BUY di completamento coppia (§4.8) — chi vuole quel BUY toglie il perno, e non
c'è una terza via.

### I due passi che armano davvero, in questo ordine

| ordine | cintura | dove | perché in questa posizione | cosa si verifica DOPO |
|---|---|---|---|---|
| **1°** | freno di agent41 · `REALLOC_SCHEDULER_DRY_RUN: '0'` | `ecosystem.config.js`, blocco agent41 | Fa sì che agent41 **tenti** il piazzamento e attraversi tutti i gate. Con `MANUAL_ORDER_PLACEMENT` ancora `dry-run` **nessun ordine raggiunge il venue**: si osserva la pipeline intera a costo zero. È il passo che si può disfare senza conseguenze. | `node scripts/cli/stato.js` → 4/5 inserite, `puoPiazzare=false`; nel giornale maker devono comparire `manual-place` con `outcome: 'dry-run-validated'` sui mercati del piano, e **zero** `outcome: 'sent'`. Se compaiono `reject-*`, si legge il gate e si ferma qui: quello è il difetto da capire, non da aggirare. |
| **2°** | `MANUAL_ORDER_PLACEMENT: 'send'` | `ecosystem.config.js`, blocco agent40 (e agent41 se piazza) | **È l'unica cintura che sta fra il piano e il libro.** Va per ultima, da sola, e con un solo mercato nel perimetro: dal momento in cui entra, ogni cosa che passa i gate diventa un ordine vero con soldi veri. | entro **due minuti**: `node scripts/cli/stato.js` → `ordini a riposo` **2** (una coppia) e non più; `node scripts/cli/mercati.js` → perimetro ancora **1**; nel giornale `outcome: 'sent'` **esattamente due volte**, con `marketRef` del perno. **Se compare un terzo ordine, o un ordine su un mercato diverso, si preme FERMA** (`node scripts/cli/ferma.js`) e si legge il giornale. |

**Le altre tre cinture** (`MAKER_MODE=live-min` · `MAKER_PLACEMENT=send` · `MAKER_ADAPTER_DRYRUN` vuota):
oggi **non cambiano niente** sul percorso che piazza (riquadro sopra). Toccarle aggiunge righe di
configurazione senza aggiungere capacità, e togliere `MAKER_ADAPTER_DRYRUN=true` dal `.env` renderebbe la
riga di `stato.js` **meno** informativa. **Raccomandazione: lasciarle inserite** e non usarle come misura
della sicurezza del giro.

### Dopo, e non prima: cosa guardare nella prima ora

| quando | cosa | rosso se |
|---|---|---|
| +2 min | `stato.js` · ordini a riposo | ≠ 2, o su un mercato che non è il perno |
| +5 min | giornale `ripristino-gamba` | `esito: rifiutata` con un gate che non sia una regola di rischio |
| +20 min | i due ordini sono ancora vivi (GTD 23 min ⇒ rinnovo) | zero ordini e nessun `manual-replace`: è il caso «lock corretto, cadenza sbagliata» di §5-bis p.173 |
| +30 min | `agent43-guardian` | un `PRE-ALLARME (1/2)` è normale; due letture consecutive fanno scattare il guardiano ed è **giusto** |
| a ogni fill | `carico-di-ripiego` con la sua `fonte` | `skip-no-entry-price`: il carico non è arrivato, e l'uscita non parte |

### Come si disarma, e quanto ci vuole

**Immediato, senza riavvio**: `node scripts/cli/ferma.js` (ferma i piazzamenti nuovi dal ciclo dopo) e il
**KILL** (`data/safety-kill-switch.json`) che cancella tutto — ⚠ il KILL ferma **anche l'uscita
automatica**, quindi lascia le posizioni aperte senza via d'uscita: è l'emergenza, non l'interruttore
operativo. **Definitivo**: rimettere `MANUAL_ORDER_PLACEMENT: 'dry-run'` e riavviare dal file.

---

## Stato del sistema — 17 agosto 2026, dopo il riavvio dei due processi (pid 270521 / 270527)

**Bot FERMO e disarmato**, letto da `/proc/<pid>/environ` e non dai file:

| | agent40 · **270521** | agent41 · **270527** | agent43 · 243973 |
|---|---|---|---|
| `MAKER_MODE` | `off` | `off` | `off` |
| `MAKER_PLACEMENT` | vuota | vuota | vuota |
| `MAKER_ADAPTER_DRYRUN` | `true` | `true` | `true` |
| `MANUAL_ORDER_PLACEMENT` | `dry-run` | assente | assente |
| `MAKER_LIVE_MIN_MARKET` | **vuota** | **vuota** | vuota |
| `REALLOC_SCHEDULER_DRY_RUN` | — | **assente ⇒ freno INSERITO** | — |

AVVIA `false` · KILL spento · allowlist **vuota** · selezione **spenta** · `guardian-state.json` assente ·
**zero ordini a libro** · **perimetro live-min = 1** (`0xe9b3e28d`, la posizione residua di Hong Kong, che
entra dall'unione di §4.8 — non un opt-in; 6 share sotto il minimo del venue ⇒ perimetro **quotabile zero**).

**Il riavvio dal file, verificato prima e dopo**: `ecosystem.config.js` dichiara **una sola** cintura, e
nella posizione **inserita** — `MANUAL_ORDER_PLACEMENT: 'dry-run'` su agent40 — più
`MAKER_FUNDING_APPROVED: 'true'` su entrambi, che non è una delle cinque ma un'attestazione, cioè una
cintura nella posizione **aperta**, già `true` da prima. **Nessuna cintura è dichiarata aperta nel file.**
Le quattro che l'ecosystem non nomina arrivano dove serve: tre dal `.env` (`MAKER_MODE=off`,
`MAKER_ADAPTER_DRYRUN=true`, `MAKER_PLACEMENT` vuota — i caricatori scrivono solo le chiavi assenti) e il
freno di agent41 per **assenza**, che è fail-closed. Dai due pid nuovi: **5/5 inserite su entrambi**,
identiche fra loro e coerenti col `.env`.

⚠ E `MAKER_FEED_BOOKS_FILE`, `MAKER_FEED_BOARD_FILE`, `POLY_CLOB_BASE` **non sono dichiarate** né
nell'ecosystem né nel `.env`: i processi vivi leggono `/tmp/clob-live-books.json`, non i file del banco.

**Posizione residua: una sola.** Hong Kong `0xe9b3e28d`, 6 share a carico 0,50, non chiudibile (punto 7).
FL-02 `0x33ec826f` non c'è più: la coppia completa è stata fusa o risolta.

---

## Come ripartire

```bash
cd /root/bot && claude --permission-mode auto
```

```bash
# 1 · LO STATO VERO, dai processi vivi
node scripts/cli/stato.js              # le cinque cinture da /proc/<pid>/environ, non dal .env
node scripts/cli/mercati.js            # perimetro live-min, stessa fonte

# 2 · IL BANCO: 18 passi su 18, 21+16 su 91, e DETERMINISTICO
cd /root/bot-banco && node scripts/ricerca/banco-scenari.js
cd /root/bot-banco && node scripts/ricerca/prova-determinismo-banco.js
cd /root/bot-banco && node scripts/ricerca/perche-non-scattano.js

# 3 · LA SUITE: 208 test, 195 verdi, 12 rossi — si confrontano i NOMI, non il conteggio
node scripts/ricerca/suite-rossi.js <nome-sessione>

# 4 · LE MISURE SUL CAPITALE PICCOLO
node scripts/ricerca/cancello-a-capitale-piccolo.js      # 40 righe candidabili con $147
node scripts/ricerca/tetto-per-ricostruire-la-coppia.js  # il tetto che servirebbe, e perché non si tocca
node scripts/ricerca/residui-sotto-il-minimo.js          # $46,79 il peggio su un mercato; l'uscita è il riscatto
node scripts/ricerca/domani-i-cinque-e-il-conto.js       # i candidabili oltre 7 g e il conto su un mercato solo
```

⚠ **Il riavvio dei due processi che decidono un prezzo si fa DAL FILE e INSIEME** (`--update-env` non
rilegge l'ecosystem), e si chiede in chat ogni volta (§2 regola 2):

```bash
pm2 restart agents/ecosystem.config.js --only agent40-manual-reprice,agent41-realloc-scheduler
```

**Per armare** non si improvvisa: la sequenza esatta, con cosa si verifica dopo ogni passo, è nella
sezione **«LA SEQUENZA DI ARMAMENTO»** qui sotto. ⚠ E prima di leggerla va letto il riquadro che la apre:
**delle cinque cinture, sulla strada da cui il bot piazza ne morde UNA.**

**La regola che vale più di tutte, imparata due volte oggi**: *un test che inietta una fixture deve
COPIARE la forma vera, non inventarla.* Tre difese scritte oggi erano inerti e i loro test erano verdi.

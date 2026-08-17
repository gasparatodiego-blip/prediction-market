# Cosa resta aperto — aggiornato il 17 agosto 2026, sera

Scritto perché una sessione nuova possa riprendere **senza rileggere tutto**. In ordine di quanto
costa se non si ripara. Lo stato del sistema al momento della chiusura è in fondo.

---

## IL QUADRO — dove siamo, in tre numeri

| | |
|---|---|
| **passi del giro completo che arrivano in fondo** | **16 su 17** — si ferma il **13** (ripristino della gamba morta) |
| **regole che scattano** | **22 statiche + 17 dinamiche su 91**, col cablaggio di produzione |
| **regole rosse perché il pezzo NON ESISTE** | **ZERO**, e non è un'ipotesi: misurato cercando i chiamanti |

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

## 1 · 🔴 IL PASSO 13 — LA COPPIA NON SI PUÒ RICOSTRUIRE, E NON È IL TETTO

Il ripristino della gamba morta **scatta, tenta, e viene rifiutato**:

```
gate: nozionale-mercato-oltre-tetto
gamba YES superstite  87,5 × $0,32 = $28,00 · gamba NO da rimettere $39,17
totale $67,17 contro il tetto $61,25   ⇒   SFORO $5,92 (9,7%)
```

**La causa è l'ASIMMETRIA delle size** (87,5 contro 62,2), non il tetto: una coppia simmetrica costa per
costruzione esattamente il capitale del mercato (`Q = C/(p_yes+p_no)` ⇒ `Q·(p_yes+p_no) = C`) e non può
sfondare. Le due gambe divergono perché **il riprezzo ricalcola la size della gamba viva** mentre il
ripristino dimensiona quella mancante sul piano corrente: due sizing diversi sulla stessa coppia.

**Quale tetto servirebbe** (`scripts/ricerca/tetto-per-ricostruire-la-coppia.js`, board vero, 36
ammissibili): per **questa** coppia **$83,13 = 1,36×**; **limite superiore** sul board **$641,36 = 10,47×**
(mid 0,0955), mediana **$245 = 4×**. Rendere la ricostruzione *sempre* possibile costerebbe un tetto
**dieci volte** l'attuale.

**La cura, e non è il tetto**: ricostruire la **COPPIA** e non la gamba — cancellare la superstite e
ripiazzare entrambe a `Q = tetto/(p_yes+p_no)` — oppure non cambiare la size nel riprezzo. Non fatta:
tocca il percorso che piazza e va fatta con la sua misura.

---

## 2 · 🟡 `carico-di-ripiego` HA DUE LIVELLI E SOLO IL PRIMO È RAGGIUNGIBILE

Il primo è `residuo-a-libro` (il prezzo di un nostro ordine ancora a riposo sullo stesso token). Il secondo
legge `deps.ultimoNostroPrezzo` e **nessuno passa quella dep**: `closeTask` non la cabla. Quindi con un
fill **totale** — nessun residuo a libro — non c'è nessun ripiego e l'uscita esce a `skip-no-entry-price`.
È un ripiego di un ripiego: va fatto con la sua misura, non a occhio.

---

## 3 · 🟡 `tre-fix-sicurezza.test.js` È UN TIMEOUT, NON UNA REGRESSIONE

Dura **48-50 s** contro il limite di **60 s** della suite (`suite-rossi.js:25`), quindi entra ed esce dalla
lista dei rossi a seconda del carico. Misurato **prima** delle modifiche di oggi 49,98 s, **dopo** 48,42 s:
non l'hanno rallentato loro. Passa 2 corse su 3 lanciato a mano. Va reso più veloce o il limite va alzato, e
la scelta è una decisione: **un test che scade è indistinguibile da un test che fallisce.**

---

## 4 · `stato.js` legge le cinture dal `.env`

**Costo**: una decisione sbagliata nel momento peggiore. In emergenza direbbe «sei fermo» mentre i processi
sono armati. 🟢 **Fatto per `mercati.js`**: il perimetro live-min si legge da `/proc/<pid>/environ` e
dichiara la divergenza col `.env`. **`stato.js` resta da fare**, stesso schema, c'è già `C.envDiProcesso`.

---

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

## 7 · 🟡 I RESIDUI SOTTO IL MINIMO NON HANNO UNA VIA D'USCITA

Buco strutturale, §5.2 p.1. La posizione di Hong Kong (6 share a carico 0,50) è l'esempio vivo: sotto
`min_incentive_size` 20 nessun ordine valido è piazzabile, quindi non è capitale perso — è **capitale
irraggiungibile fino alla risoluzione**. La proposta (riscattarli via `redeemPositions`) è scritta e non
implementata: è capitale, ed è una decisione dell'operatore.

---

## LE 69 REGOLE CHE NON SCATTANO, DIVISE PER CAUSA

`node scripts/ricerca/perche-non-scattano.js` — e le due categorie chiedono cose diverse:

### A · IL GIRO NON CI È ARRIVATO — **65**

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
| **nessuna** | — | **ZERO regole rosse perché il pezzo non esiste** — misurato: per tutte e 69 il chiamante c'è |
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

## Stato del sistema — 17 agosto 2026, dopo il riavvio dei tre processi

**Bot FERMO e disarmato**, letto da `/proc/<pid>/environ` e non dai file:

| | agent40 · 243867 | agent41 · 243868 | agent43 · 243973 |
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

⚠ **`ecosystem.config.js` dichiara DUE variabili della famiglia delle cinture**, e la frase «non ne
dichiara nessuna» era sbagliata: `MANUAL_ORDER_PLACEMENT: 'dry-run'` (la cintura nella posizione
**inserita**, di proposito) e **`MAKER_FUNDING_APPROVED: 'true'`** su agent40 e agent41 — che sta nella
famiglia 1 dei permessi ed è la posizione **aperta**. Era già `true` prima del riavvio: il riavvio dal file
non ha cambiato niente, ma non è una delle cinque che restano inserite.

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
# 1 · LO STATO VERO, dai processi vivi (⚠ stato.js legge le cinture dal .env: punto 4)
node scripts/cli/mercati.js            # perimetro live-min da /proc, non dal .env

# 2 · IL BANCO: 16 passi su 17, 22+17 su 91, e DETERMINISTICO
cd /root/bot-banco && node scripts/ricerca/banco-scenari.js
cd /root/bot-banco && node scripts/ricerca/prova-determinismo-banco.js
cd /root/bot-banco && node scripts/ricerca/perche-non-scattano.js

# 3 · LA SUITE: 206 test, 192 verdi, 13 rossi — si confrontano i NOMI, non il conteggio
node scripts/ricerca/suite-rossi.js <nome-sessione>

# 4 · LE MISURE SUL CAPITALE PICCOLO
node scripts/ricerca/cancello-a-capitale-piccolo.js      # 40 righe candidabili con $147
node scripts/ricerca/tetto-per-ricostruire-la-coppia.js  # il tetto che servirebbe, e perché non si tocca
```

⚠ **Il riavvio dei due processi che decidono un prezzo si fa DAL FILE e INSIEME** (`--update-env` non
rilegge l'ecosystem), e si chiede in chat ogni volta (§2 regola 2):

```bash
pm2 restart agents/ecosystem.config.js --only agent40-manual-reprice,agent41-realloc-scheduler
```

**Per armare** servono **cinque** cinture, tutte insieme, più il perno: `MAKER_MODE=live-min` ·
`MAKER_PLACEMENT=send` · `MANUAL_ORDER_PLACEMENT=send` · `MAKER_ADAPTER_DRYRUN` vuota · freno di agent41
disinserito (`REALLOC_SCHEDULER_DRY_RUN=0`) · `MAKER_LIVE_MIN_MARKET=<il mercato del giro>`. Il perno è ciò
che rende il perimetro **stabile e nominato** invece di una conseguenza dell'unione — e va scritto in
`agents/ecosystem.config.js`, dove si vede in git, in `pm2 env` e in `/proc`.

**La regola che vale più di tutte, imparata due volte oggi**: *un test che inietta una fixture deve
COPIARE la forma vera, non inventarla.* Tre difese scritte oggi erano inerti e i loro test erano verdi.

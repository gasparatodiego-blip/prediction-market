# CLAUDE.md — contesto permanente del progetto

Questo file viene letto automaticamente all'avvio di ogni sessione Claude Code aperta da
`/home/bot/bot`. **Il contesto vive qui, non nel prompt.**

Ultima verifica contro codice/stato reali: **23 agosto 2026**. Le cinture, il numero di mercati e le
distanze si leggono da `/proc/<pid>/environ` degli 11 processi vivi. Il quadro del giro è in `APERTI.md`.

> ⚠️ **QUESTO FILE È STATO POTATO TRE VOLTE**: il **13 agosto 2026** (494k → ~110k), il **22 agosto**
> (202k → ~119k) e il **23 agosto** (**163k → ~118k**), tutte su istruzione dell'operatore. **Non è stata
> tolta nessuna regola, nessuna costante, nessun parametro, nessuna trappola operativa e nessuna questione
> aperta**: è stata tolta la **cronologia**, cioè il racconto di come si è arrivati a decisioni che oggi
> sono semplicemente vere. **Niente è stato cancellato: tutto è stato SPOSTATO**, e la verifica è
> meccanica — ogni riga del CLAUDE.md pre-potatura esiste verbatim o qui o sotto `docs/`.
>
> | file | cosa contiene |
> |---|---|
> | `docs/registro-voci-chiuse.md` | **§5-bis per intero**: le voci chiuse **1-205** col numero originale (così «§5 punto 72» resta risolvibile), le sezioni del 13 agosto, il registro 1-119, più le voci di §5.2 **chiuse** (p.37, p.49, p.54, p.57) con la diagnosi integrale |
> | `docs/storia-per-sezione.md` | Per ogni sezione potata il **testo integrale prima della potatura** — quelle del 13 e 22 agosto, e dal 23 agosto anche §3, §4.1, §4.1-bis, §4.2, §4.4, §4.6, §4.7, §4.8, §4.9, §4.10, §4.13, §4.14 e la testata |
> | `docs/referti-difetti-corretti.md` | **NUOVO (23 agosto)**: il referto integrale dei difetti **già corretti** — il fatto, la misura, la diagnosi, perché la cura è quella (filo del rinnovo tagliato, pavimento della scala fuori griglia, coppia asimmetrica, copertura continua) |
> | `docs/misure-e-tarature.md` | **NUOVO (23 agosto)**: la **misura** dietro i numeri in servizio — distanza obiettivo, tetto della coppia a 101¢, presa di profitto, abbandono, GTD di chiusura, erosione del book, filtro meteo, slot sterile, deroga di secchio |
> | `docs/episodi-chiusi.md` | I quattordici riquadri narrativi che stavano in cima a CLAUDE.md |
> | `docs/permessi-e-hook.md` | La policy dei permessi (164 regole `ask`, le tre famiglie, le 19 forme di scrittura) e l'hook `blocca-piazzamento.js` per esteso |
>
> **⚠ Le questioni APERTE di §5.2 sono rimaste qui per intero e non si spostano.** Chi chiude una voce la
> sposta in `docs/registro-voci-chiuse.md` e lascia in §5.2 una riga «✅ CHIUSA» col rimando.
> **Chi aggiunge una voce nuova scriva già compatto.**

---

> ## ✂️ DOVE VIVE IL BOT, E COM'È ARMATO
> **⚠⚠ IL REPO È IN `/home/bot/bot` E L'UTENTE È `bot`.** `/root` non è leggibile: ogni percorso assoluto
> che dica `/root/...` è **storia, non stato** (§5-bis p.188). pm2 **7.0.3** sotto `/home/bot/.pm2`,
> PostgreSQL **16**, database e utente `rewardsbot`, **14 tabelle**; `.env` gitignored, `chmod 600`.
> **⚠ I FILE DI SERVIZIO NON SONO IN `/tmp` NUDO** ma in `/tmp/rewards-bot-<utente>` (0700), definizione
> unica in `lib/percorsi-runtime.js` (§5.3). **LA RIDUZIONE (15/08)**: 568 file su 1.267 **spostati** — mai
> cancellati — in `_archivio` (`mv _archivio/<p> <p>` riporta indietro; `INDICE-SPOSTATI.json` è l'elenco);
> la catena serve **486 file**. **⚠ `_archivio` è ESCLUSO dai sei test strutturali.**
> ## 🔴🔴 IL BOT È ARMATO E OPERA CON CAPITALE VERO — dalle 16:21Z del 18 agosto 2026
> **STATO LETTO DAI PROCESSI VIVI**: flotta a 11 processi ONLINE (§5.1) · `MAKER_MODE=live-min` ·
> `MAKER_ADAPTER_DRYRUN=false` · **`MANUAL_ORDER_PLACEMENT=send`** su agent40 **e** agent41 · freno di
> agent41 `=0` ⇒ **ZERO CINTURE INSERITE, 0/4** (§4.14) · **`MAKER_MERCATI_CONTEMPORANEI=18`** su agent41
> **e su agent40** (R1; dal 24/08 **NON HA PIÙ UN DIFETTO**: assente o fuori da 1..20 ⇒ i due processi
> **non partono**) e **`MAKER_SLOT_CORTI=2`** · **⚠ FILTRO METEO ARMATO —
> `MAKER_FILTRO_METEO` NON ESISTE** (§5.2 p.69) · **`SLOT_STERILE_ARMATO` ASSENTE ⇒ regola dello slot
> sterile ARMATA** · KILL spento · selezione automatica **ACCESA** · perno **vuoto**.
> ⚠ **QUANTI ORDINI CI SIANO A LIBRO NON SI SCRIVE QUI: SI LEGGE**, da `data/venue-orders.json`, che
> agent40 scrive da letture VERE del venue — **non** ricostruendolo dal giornale. **Una ricostruzione non è
> una lettura**: il 18/08 sera così sono stati dichiarati «4 mercati, 8 ordini, $209,08» mentre al venue ce
> n'erano 2.
> **⚠ CIÒ CHE RESTA DAVANTI NON SONO PIÙ CINTURE, È STATO DEL SISTEMA**: il KILL, il tetto per ordine
> ($65,63), il tetto per mercato ($61,25), l'esposizione cumulativa (**$2.400**, §4.2), il rate limit, la
> perdita giornaliera a **−$100**, «mai primo sul libro» e la banda premiante. **Il freno vero è il kill a
> −$100**, non il tetto di esposizione.
> **⚠ `MAKER_MODE` NEL `.env` DICE ANCORA `off`, ED È INERTE**: pm2 tiene la propria copia dell'ambiente e
> i caricatori `.env` scrivono solo le chiavi **assenti**. Quello che conta è `agents/ecosystem.config.js` +
> riavvio **dal file**. ⚠ `scripts/cli/stato.js` stampa una riga «`.env` (cosa entrerebbe al prossimo
> riavvio DAL FILE)» che è **sbagliata e rassicura**: legge il solo `.env`. **Da correggere.**
> **⚠ OGNI RIAVVIO DI agent40 ABBANDONA GLI ORDINI GIÀ A LIBRO**: diventano **PRE-ESISTENTI**, cioè
> «invisibili al motore — non riprezzati, non rinnovati, non cancellati» (`ordini-preesistenti.js`, regola
> voluta). Con `send` aperto **un deploy condanna il libro esistente alla morte per GTD**.
> **I COMANDI CHE SOSTITUISCONO IL PANNELLO** (`scripts/cli/`, ognuno dichiara cosa sta per cambiare e cosa
> ha cambiato): `mercati.js` · `distanza.js` · **`stato.js`** · `avvia.js` · `ferma.js` · `selezione.js`.
> Passano dagli **stessi moduli** degli agent. **Nessuno può accendere la modalità viva.** `avvia.js`
> **LEGGE il KILL e si rifiuta di partire mentre è attivo, senza spegnerlo**; `stato.js` verifica su di sé,
> camminando `require.cache`, di non aver caricato nessuna superficie che sappia agire sul venue.
> **LE VERIFICHE, in ordine di quanto provano**: `node scripts/ricerca/banco-scenari.js` (**26/26**,
> deterministico e identico su due snapshot di `data/`) · `node scripts/ricerca/prova-cinture.js` (10/0, col
> controllo) · `node scripts/ricerca/suite-rossi.js <nome>` (confronta i **NOMI**, §5.2 p.11) · i 5
> selfcheck di `scripts/` · `node scripts/verifica-catena-rewards.js`.
---

> ## ⚖️ LE DIECI REGOLE CONCORDATE — 18 agosto 2026, decise dall'operatore
> **Sono la SPECIFICA del bot, e il testo integrale con `file:riga` e il passo del banco che le prova sta
> in `APERTI.md` §0.** Qui resta il riferimento, perché chi cambia una di queste cambia il bot.
> **1** quanti mercati (`MAKER_MERCATI_CONTEMPORANEI`, agent41, un posto solo, letto da `/proc`) ·
> **2** scelta (pavimento ≤ $61,25 · ≥ 24 h · no meteo · ordina per netto) ·
> **3** ingresso (due gambe, stessa size decisa insieme, bordo esterno) ·
> **4** riprezzo sul **book** e non solo sul mid (§4.1-bis) ·
> **5** fill parziale (copre l'esatto, cancella sempre il residuo, poi merge) ·
> **6** residuo sotto il minimo (si chiude sempre) ·
> **7** fill totale (taker < 101¢, poi 30 min maker, poi la scala fino al **5%**) ·
> **8** merge (coppia completa ⇒ subito, sempre, **senza limiti di prezzo**) ·
> **9** rotazione (+$0,50/g o +25%; mai con posizione, coppia incompleta o ordini vivi) ·
> **10** kill a −$100 (cancella **E** chiude le posizioni).
> **⚠ CHI CAMBIA UNA REGOLA DEVE CAMBIARE ANCHE IL SUO PASSO DEL BANCO** (18-23), o la prova resterebbe a
> difendere la regola vecchia — che è esattamente come tre difese sono rimaste inerti col verde (p.181).
> **⚠ DUE DIVERGENZE CONFERMATE, dove il codice è PIÙ PRUDENTE della regola e resta com'è**: il margine dal
> bordo è `max(1 tick, 0,22·banda)` e non un tick; il kill **non ha auto-riarmo affatto**.

> ## ➕ EMENDAMENTO ALLA REGOLA 7 — LA PRECEDENZA DEL MERGE AL GRADINO 3
> **24 agosto 2026, decisione dell'operatore. Scritta come REGOLA, non come eccezione.**
>
> **Quando una gamba è al gradino 3 della scala d'urgenza (oltre 240 min di scopertura) ma la coppia sta
> ANCORA sotto 101¢, l'acquisto della gamba sorella con merge immediato PREVALE sulla vendita.** La
> ragione è aritmetica e non discrezionale: il merge di una coppia completa rende **$1,00/share garantito**
> (§4.9, gas del relayer, zero slippage), mentre la vendita al gradino 3 realizza una perdita — concede
> fino al **5% del carico** (R7) e incassa il bid camminato, che è sempre meno di $1,00 meno il costo della
> sorella quando la coppia è sotto 101¢. Comprare a completare non è un ripiego più lento: è l'unica delle
> due vie che non perde denaro.
>
> **⚠ LA VENDITA DEL GRADINO 3 RESTA L'UNICA VIA QUANDO LA COPPIA SUPERA 101¢.** Sopra quel tetto
> completare costerebbe più di quanto il merge renda, e allora la perdita è già stata fatta: si sceglie la
> più piccola. Il tetto della coppia (`MAKER_TETTO_COPPIA_CENTS`, un punto solo, §4.6) è il discriminante,
> e **non si allarga per far entrare questo emendamento**: la metà di R6 che comprerebbe *sopra* 101¢
> resta non implementata e resta una decisione aperta (§5.2 p.44).
>
> **⚠ QUESTO EMENDAMENTO NON AUTORIZZA NIENTE DI NUOVO, RENDE ESPLICITA UNA PRECEDENZA CHE IL CODICE HA
> GIÀ**, e va letto così o diventa il permesso per un meccanismo che nessuno ha scritto. La scala di §4.6
> mette il merge al **Livello 0**, il taker sulla sorella al **Livello 1** e il maker a riposo sulla
> sorella al **Livello 2** — tutti e tre con il vincolo `coppia ≤ 101¢` — e la vendita peggiorativa
> soltanto ai gradini 2-3 dell'urgenza. L'ordine è quindi già quello che questo emendamento dichiara; ciò
> che mancava era la riga che lo dice, così che chi legge un giornale non prenda per un'eccezione ciò che
> è la regola.
>
> **⚠ OSSERVATO SUL VIVO MENTRE VENIVA SCRITTO**, ed è la prova che la precedenza è cablata e non
> soltanto voluta: `0x4d79d306` è **al gradino 3** (scoperto da 28,7 h, `scoperto-oltre-soglia-grave` ×751)
> e la scala **non sta vendendo per chiudere**: tiene un BUY a riposo sulla sorella YES per 56,1 share a
> **51,6¢** (`merge-livello-2-piazzato`), cioè esattamente `101¢ − carico 49,4¢`. Il merge ha la
> precedenza, e il tetto della coppia è il numero che la fissa.
>
> **⚠ NON ANCORA ESERCITATO SU CAPITALE, e va detto**: il giro del 24 agosto che ha prodotto questo
> emendamento **non ha comprato nessuna gamba sorella** — le due coppie completabili sono state rifiutate
> dal **minimo d'ordine del venue** (5 share contro 4,85 e 2,01; v. `APERTI.md`). L'emendamento è quindi
> scritto **prima** del suo primo uso, non a giustificarne uno.

---

## 🟢 STATO OPERATIVO — letto dai processi vivi

Capitale all'ultima lettura di agent41: **$1.497,04**. Guardiano perdite in servizio,
`data/guardian-state.json` assente (l'assenza *è* lo stato sano).

> ## 🔻 IL GRADINO 6 È DISARMATO — decisione dell'operatore, §5-bis p.153/159
> `SBLOCCO_GRADINO6_ARMATO='0'` nell'`env` di agent41. Non è un difetto: armarlo metterebbe il bot su
> **FERMA senza riarmo automatico** — una mano umana per ripartire, con la causa a monte ancora aperta.
> **⚠ DISARMATO NON VUOL DIRE ASSENTE**: la scala sale ancora fino a 6 e il gradino **registra che sarebbe
> scattato e perché** (`data/realloc-scheduler.jsonl`, `disarmato:true`; giornale maker,
> `outcome:'gradino-6-disarmato'`). Conta **episodi**, non tick.
> **⚠ NESSUNA DIFESA VERA È TOCCATA**: guardiano delle perdite, sentinella del collasso e KILL non passano
> da questa scala, e un test lo verifica per assenza.
> **PER RIARMARLO**: si cancella quella riga da `agents/ecosystem.config.js` e si riavvia agent41. Il
> difetto **in assenza della variabile è ARMATO** — un env che sparisce non può spegnere una difesa.
> ## 📚 I QUATTORDICI EPISODI CHIUSI — narrativa in **`docs/episodi-chiusi.md`**, qui solo dove sono le REGOLE
> il **vuoto di tre ore** ⇒ §4.3 (griglia limitata anche dal tetto, 8 livelli minimi) + sentinella sul
> vuoto (5 min) + recupero della scadenza a tre fonti (§4.6) · il **capitale al lavoro** ⇒ §4.5 · **dove
> muoiono le gambe** ⇒ §4.2 · **quanti mercati vede il bot** ⇒ §4.7 e §5.2 p.55 · la **scala di urgenza**
> ⇒ §4.6 · i **residui sotto il minimo** ⇒ §4.6 e il riscatto on-chain (bloccato adesso **$3,00**) · il
> **guardiano k=2** ⇒ §3.
> ⚠ **Pannello Polymarket e bot misurano cose diverse e possono essere entrambi giusti**: «disponibile per
> il trading» **è il cash** e non sottrae i BUY a riposo; il bot conta **posizioni + ordini a riposo**.
> ⚠ **`ultimoCicloOk` si timbra in TRE punti** — a fine giro e nei due rami «nessuna azione».
> ## 🧩 QUATTRO MECCANISMI SECONDARI, VIVI — testo integrale in **`docs/meccanismi-secondari.md`**
> **🤖 IL BOT SI SBLOCCA DA SOLO** — principio: **ogni difesa AGISCE, non segnala soltanto**; e la metà
> opposta, **quando l'unica via d'uscita violerebbe una regola di rischio il bot non agisce e lo
> dichiara**. Scala di sblocco, un gradino ogni **5 minuti**, fino a `fermati-in-sicurezza` (gradino 6,
> **DISARMATO**): caso peggiore FERMA in ~30 minuti. **Nessun gradino tocca una regola di rischio**, per
> struttura. Autodiagnosi ogni **120 s**; tutto illeggibile ⇒ **non si giudica** e la scala non parte.
> **💰 RISCATTO AUTOMATICO DOPO LA RISOLUZIONE**: il segnale è `payoutDenominator(conditionId) > 0` **letto
> ON-CHAIN**, non «il mercato è chiuso». **Non letto ⇒ non si riscatta.**
> **🧹 QUARANTENA VENUE** (`quarantena-venue.js`, **20 minuti**): l'esito della verifica al venue
> **sopravvive al ciclo**. **Non è un cancello.**
> **📉 SENTINELLA SUL COLLASSO DELLA COPERTURA — SOLO OSSERVA**: calo **≥ 85% dal MASSIMO delle ultime 10
> minuti**. **Log e giornale soltanto**: non ferma il bot e non tocca AVVIA/FERMA (verificato per assenza).
> **🪙 LA GAMBA SORELLA SI ABBASSA DENTRO LA BANDA** quando il tetto della coppia cade sopra il bordo alto.
> **⚠ Non allenta niente**: è un `Math.min`, il prezzo può solo scendere.
---

---

## 1 · STACK E INFRASTRUTTURA

Bot di **liquidity rewards su Polymarket**: piazza ordini maker *fermi* dentro la banda premiante e
incassa i premi di liquidità del venue. I reward si pagano sugli ordini **a riposo**, non sui fill —
per un maker l'esecuzione è il costo, non il ricavo.

| | |
|---|---|
| Runtime | Next.js 14.2 (App Router) · Node v20.20.2 · TypeScript |
| DB | Prisma 5 → **PostgreSQL** 16 (`DATABASE_URL` in `.env`), database e utente `rewardsbot`, 14 tabelle |
| Processi | **pm2 7.0.3** sotto `/home/bot/.pm2`; **11 online** (§5.1), uno (`agent44-audit-scoperta`) schedulato e a riposo, gli altri definiti e deliberatamente fermi |
| Server | Hetzner Helsinki, Ubuntu, `62.238.52.227` (verificato) |
| Path | Repo in **`/home/bot/bot`**, utente **`bot`**. ⚠ Ogni `/root/...` in questo file è storia |
| Repo | GitHub privato `git@github.com:gasparatodiego-blip/prediction-market.git`, branch `main` |

**Capitale reale connesso.** Funder on-chain `0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee` (è un
*contratto* deposit-wallet ERC-1271, `MAKER_SIGNATURE_TYPE=3`; l'EOA firma e non detiene nulla).
**Il saldo invecchia: non citarlo a memoria, rileggilo** (lettura on-chain, sola lettura) —
`leggiSaldoUsd()` di `lib/maker/saldo-cache` + `readVenuePositions()` di
`lib/safety/venue-positions-snapshot`; lo snippet completo è in `docs/storia-per-sezione.md` §1, e
`node scripts/cli/stato.js` dà la stessa lettura senza incollare niente.

## 2 · REGOLE DI SICUREZZA FISSE

**Invariabili. Non si riscrivono senza istruzione esplicita dell'utente in chat.**

1. **Mai toccare lo schema Prisma né modificare il database di produzione.** Niente `migrate`,
   niente `db push`, niente `UPDATE`/`DELETE` su Postgres.
2. **Mai fermare o riavviare un processo pm2 senza conferma esplicita dell'utente in chat, ogni
   volta.** Un'autorizzazione vale **solo per quel riavvio specifico**: non si estende al successivo,
   né a un altro processo, né al giorno dopo. Vale per `restart`, `stop`, `delete`, `reload`.
   *(Questa regola sostituisce la precedente «restart senza go-ahead». La allowlist dei permessi
   decide cosa non apre un prompt tecnico; questo file decide cosa devo comunque chiedere.)*
3. **Mai piazzare ordini reali senza conferma esplicita dell'utente in chat.** Due sole eccezioni,
   e sono le uniche azioni su capitale reale che procedono in autonomia:
   - **(a) agent41** — riallocazione periodica, quando è fuori dry-run *e* il bot è su AVVIA;
   - **(b) agent43-guardian** — cancellazioni automatiche in caso di perdita oltre soglia.
4. **`npm run build` in autonomia; il restart no** (vedi regola 2).
5. **Ogni modifica di codice va deployata subito sul bot live** — build + attivazione — non solo
   committata. Il deploy che richiede un restart pm2 si chiede (regola 2) e si esegue subito dopo.
6. **Commit e push su `main` per ogni modifica significativa**, salvo istruzione contraria.
7. **Verifica sempre a fondo prima di dichiarare concluso un lavoro.** Non fermarsi alla prima
   lettura superficiale: leggere il codice che decide davvero, non il commento che lo descrive, e
   controllare lo stato runtime (`pm2 env`, i file in `data/`) e non solo la configurazione.

### I due interruttori, e chi decide cosa

**ARM / DISARM non esiste più** (rimosso il 9 agosto 2026 insieme ad `agent35-maker`, l'unico processo
che lo leggeva): restano i due che decidono davvero.

| Interruttore | File / flag | Semantica |
|---|---|---|
| **AVVIA / FERMA** | `data/maker-bot-enabled.json` via `lib/maker/bot-enabled.js`, bottone in cima alla tab **Mercati ottimizzati** | Decide se il bot apre posizioni da solo. `agent41` lo rilegge **a ogni ciclo**: FERMA vale dal ciclo dopo, senza restart. File mancante/illeggibile/malformato ⇒ **fermo**. Ferma i piazzamenti *nuovi*, lascia gestite le posizioni aperte (auto-close, riprezzatura, rinnovi). |
| **KILL** | `data/safety-kill-switch.json`, `lib/safety/kill-switch`, `/api/maker/kill` | Emergenza assoluta. Lo leggono tutti i percorsi **compreso `auto-close`**: killare lascia le posizioni aperte *senza uscita*. Non è l'interruttore operativo. **Invariato dalla rimozione dell'arming**: la rotta faceva due cose e ora ne fa due — interruttore durevole + spazzata di cancellazione — perché il ritiro dell'arming era un parametro **opzionale**. |

`REALLOC_SCHEDULER_DRY_RUN` **è stato rimosso** il 7 agosto 2026 da `ecosystem.config.js` e da ogni
riga di `agent41`. Non reintrodurlo e non aggiungere un env di fallback accanto ad AVVIA/FERMA: due
interruttori per una decisione sola significano che spegnerne uno non la spegne. Un test
(`lib/maker/gestione-manuale-nel-flusso.test.js`) fallisce se ricompare.
`REALLOC_SCHEDULER_ENABLED` **non** è un secondo interruttore: decide se il processo fa qualcosa,
non se può piazzare.

### Permessi della sessione e hook — dettaglio in **`docs/permessi-e-hook.md`**

> ## 🔴🔴 LA POLICY È SVUOTATA DAL 19 AGOSTO 2026, E QUESTA SEZIONE DESCRIVEVA QUELLA DI PRIMA
> **Corretto il 24 agosto 2026 dopo verifica sul disco. Reperto D7, la variante peggiore: il documento
> dichiarava due linee di difesa che non esistono e si citava da solo come prova (come §5.2 p.69).**
> **LO STATO VERO, letto e provato**: `.claude/settings.json` (345 byte) e `~/.claude/settings.json`
> (338 byte) portano **solo** una `allow` ampia — **`ask: []`**, **nessun blocco `hooks`**. Idem
> `.claude/settings.local.json` (che ha solo `allow`). `lib/safety/policy-permessi.test.js` gira **10/10**
> e si intitola *«POLICY DEI PERMESSI — svuotata per decisione dell'operatore (19 agosto 2026)»*: asserisce
> **zero** regole `ask` nei tre file, **nessun** hook registrato, le due copie **allineate a zero**, e
> l'hook *«sul disco, disarmato · NON registrato in nessuna configurazione»*.
> **⇒ NON C'È NESSUN PRESIDIO TECNICO SUI PIAZZAMENTI IN SESSIONE.** Nessuna regola `ask` chiede niente e
> l'hook non viene mai invocato — verificato il 24/08 con una sonda che **importa `placeManualOrder`** ed
> è passata. **Il presidio è la regola 3 di §2 — conferma esplicita dell'utente in chat — e il giudizio di
> chi lavora. Nient'altro.** Chi conta le difese conti queste.
> **⚠ PER RIARMARE** serve una riga di `hooks` nei settings **e** la correzione di
> `blocca-piazzamento.js:44` (`const RADICE = '/root/rewards-bot'`, percorso morto usato in tre punti —
> §5-bis p.188), o si otterrebbe un hook che sbaglia le esenzioni. È una decisione dell'operatore.
> **⚠ IL TESTO QUI SOTTO RESTA COME DESCRIZIONE DI COS'ERA E DI COSA TORNEREBBE SE SI RIARMASSE**, non
> come stato: si legge al passato.

`.claude/settings.json` (progetto) e `~/.claude/settings.json` (utente) **portavano** una **copia identica**
della stessa policy: `allow` ampio + **164 regole `ask`**. `ask` batte `allow` da qualunque file arrivi, e
le regole si **fondono**. `.claude/settings.local.json` deve restare privo di regole `ask`. Le due copie
vanno tenute in sync, e `lib/safety/policy-permessi.test.js` **oggi asserisce l'opposto — che siano vuote
entrambe** (v. il riquadro sopra).

**Le tre famiglie, con criteri diversi apposta:** **①** capitale reale ⇒ `ask` **anche in lettura**: basta
*nominare* la cosa, e **questa famiglia non si allarga**. **②** pm2 ⇒ `ask` **se nominato**
(`restart`/`stop`/`delete`/`reload`/`kill`/`startOrRestart`); `list`/`describe`/`env`/`logs` passano.
**③** flag di stato e sicurezza ⇒ `ask` **solo in scrittura**, con la stessa famiglia di **19 forme** per
ognuno dei sei flag; la lettura passa in autonomia. ⚠ **Eseguire** un file che nomina il flag chiede
**anche quando è il suo stesso test**.

**L'hook** `.claude/hooks/blocca-piazzamento.js` (**DISARMATO dal 19/08: sul disco, non registrato**;
quando era armato: `PreToolUse`/`Bash`) **apre il file e cammina il grafo dei `require`** fino a profondità 3 cercando la superficie di
piazzamento vera. **Cancellare non è in elenco** — può solo ridurre l'esposizione, e il guardiano deve
poterlo fare. Tre esenzioni dichiarate: le letture (valutate **segmento per segmento**), i `*.test.js` del
repo, il **corpo di un heredoc** (torna a contare se va in pasto a `node`). **⚠ Un riavvio pm2 non passa
dall'hook**: lì il presidio sono le regole `ask` della famiglia ②.

**⚠ Limite dichiarato della famiglia ③**: la copertura è per *forme note* di scrittura, non per costruzione
(`install`, `sponge`, `awk` con redirezione indiretta, `git reset --hard` senza path…). **Il presidio vero
resta la regola 3 di §2.** Chi aggiunge un flag di stato aggiunge le **19 forme** e lo mette nell'elenco
`FLAG` di `lib/safety/policy-permessi.test.js`.

Le sessioni si aprono da `/home/bot/bot`: `claude --permission-mode auto`.

### Guardrail auto-resume

Se il turno corrente è stato aperto da un risveglio automatico (ScheduleWakeup o simile) e **non** da
un messaggio umano: build, test, edit, commit locali restano autorizzati; **`git push` e qualunque
deploy o restart pm2 no**, anche se il prompt che ha programmato il risveglio diceva «senza gate».
Si completa tutto il resto, si dice cosa è pronto, e si aspetta il messaggio umano successivo.

---

## 3 · AGENTI CHIAVE

*(Testo integrale prima della potatura del 23/08: `docs/storia-per-sezione.md`.)*

**LA FLOTTA VIVA È DI 11 PROCESSI** (§5.1) e si legge, non si crede: `node scripts/cli/stato.js` confronta
i definiti e i vivi nei due versi. `agent35-maker` e `agent37-maker-watchdog` **sono stati rimossi il 9
agosto 2026**; il `dashboard` non è più nella flotta, ma i sorgenti sotto `app/` restano sul disco perché
32 test strutturali li leggono.

| pm2 | Cosa fa | File |
|---|---|---|
| `agent34-clob-ws` | Feed **websocket** dei book CLOB. Sola lettura, canale pubblico e senza chiavi: non può firmare, piazzare o cancellare nulla. Alimenta tape e mid-history. | `agents/agent34-clob-ws.js` |
| `agent38-tape-watchdog` | Watchdog di **continuità** dei giornali: copre il buco che l'auto-heal del socket di agent34 non vede. | `agents/agent38-tape-watchdog.js` |
| `agent40-manual-reprice` | **Riprezzatura / uscita dalla banda**: l'asse non è la scadenza a 180 s ma «l'ordine è ancora dentro la banda che paga?». Scrive lo snapshot posizioni. | `agents/agent40-manual-reprice.js` |
| `agent41-realloc-scheduler` | **Riallocazione periodica** (ogni 6 h, due trigger indipendenti: *validità* e *valore*) + **trigger a capitale fermo** (ogni 2 min, un trigger solo: collaterale libero sopra **$50**). **È l'unico processo che può cancellare e piazzare ordini veri senza conferma umana**, per eccezione esplicita dell'operatore. | `agents/agent41-realloc-scheduler.js` |
| `agent42-watch-makers` | Monitor dei **21 maker di riferimento**. L'unico processo che **non può toccare capitale nemmeno in linea di principio**. | `agents/agent42-watch-makers.js` |
| `agent24-liquidity-rewards` | Scanner dei mercati con reward: ogni 15 min legge Gamma + book e assegna il punteggio con la formula quadratica esatta del venue. | `agents/agent24-liquidity-rewards.js` |
| `agent27-news-guard` | Guardia notizie/volatilità: segnala che il prezzo sta per muoversi, così le quote si ritirano prima del fill avverso. | `agents/agent27-news-guard.js` |
| `agent43-guardian` | **Guardiano delle perdite economiche** — vedi la scheda sotto. | `agents/agent43-guardian.js` |
| `agent45-osservatore` | **L'osservatore muto**: un campione ogni **60 s** in `data/osservatore/` + giornale degli eventi. **Non decide, non agisce, non avvisa.** Strutturalmente incapace di toccare capitale. **Read-only ⇒ riavviabile senza conferma.** | `agents/agent45-osservatore.js` |
| `agent-monitor` | Sorveglia la flotta via heartbeat e riavvia gli agenti fermi, con circuit breaker per agente. | `agents/agent-monitor.js` |
| `dashboard` | Il Next.js su porta 3000. **Non è più nella flotta** (§5.1). | `npm start -- --port 3000` |

**Non sempre vivo, e apposta — `agent44-audit-scoperta`**: legge il codice, cerca i pattern di rischio che
qui hanno già prodotto guasti veri, scrive la coda ed **esce** (non corregge, non tocca ordini né capitale,
non scrive altro che la propria coda — provato da un test che cammina l'albero dei `require`).
`cron_restart: '7 3 * * *'` + `autorestart: false`; 63-68 s, **nice 19**, **ionice idle**, deadline 12 min,
vigile interno oltre 150 MB. **Sette rilevatori**, ognuno nato da un guasto vero: **D1** (costanti dello
stesso concetto con valori diversi) · protezioni presenti su un percorso e assenti su un altro · stima che
diverge dal consuntivo · flag che nessuno legge più · test rossi · collisioni di numerazione · **D7**
(commenti fermi a un valore che non è più quello). Report: `data/audit-coda.json`/`.md`,
`node scripts/vedi-audit.js`; **niente sparisce** (risolto/riaperto con la data, `primaVisto` mai
sovrascritto).

**Il controllo dei percorsi, in tutti e nove gli agent che scrivono** (`lib/safety/percorsi-critici.js`,
all'avvio): radice del package, `data/` scrivibile, directory di servizio creabile, ogni file di servizio
**già esistente** scrivibile da noi. Su guasto: stderr + `exit 1`. ⚠ Un file **assente** non è mai un
errore, e non si controlla il **contenuto**.

**La scheda del guardiano** — `agent43-guardian`, ogni 30 s confronta (saldo pUSD + posizioni al prezzo
corrente) col **riferimento a massimo mobile** in `data/guardian-baseline.json`. Oltre `GUARDIAN_LOSS_PCT`
(**5%**) o la **soglia assoluta DERIVATA** (5% del riferimento; `GUARDIAN_LOSS_ABS` è il pavimento in
dollari) cancella **tutti gli ordini a riposo**, deposita `reason='guardian-auto-kill'` e mette il bot su
**FERMA**; non tocca le posizioni aperte e non ferma l'uscita automatica. Soglie rilette da `.env` **a ogni
giro**. **Strutturalmente incapace di piazzare** (unica superficie: `lib/maker/cancel-all`), verificato da
un test che cammina l'albero dei `require`. **Le sei regole** (dettaglio: `docs/storia-per-sezione.md`):
⟨1⟩ **k = 2 letture** consecutive e contigue prima di scattare. ⟨2⟩ **LE DUE FONTI DEVONO DESCRIVERE LO
STESSO ISTANTE** (§5.2 p.54 chiusa): `riconciliaFonti` (pura) pretende `Δcassa + Δsize ≈ 0` (tolleranza
**$6,00**), e se non lo è **il totale non è misurabile** e il giro finisce lì — ⚠ si riconcilia la parte
dovuta alle **SIZE**, non il **VALORE**, perché un movimento di solo prezzo è P&L vero e il guardiano lo
deve VEDERE; ⚠ costa un giro (30 s) dopo un riavvio, e i rifiuti vanno a verbale. ⟨3⟩ **IL RIFERIMENTO
SCENDE SUBITO E SALE SOLO SU CONFERMA** (seconda lettura **distinta e contigua**, poi sale al **minimo
delle due**); depositi e prelievi sono cassa esterna, non P&L. ⟨4⟩ **NESSUN RIARMO AUTOMATICO DI AVVIA, per
decisione**: si riparte cancellando `data/guardian-state.json` **a mano**. ⟨5⟩ **L'AVVISO**
(`allarme-guardiano.js`) è cablato come **ULTIMO** passo di `spazzaEFerma` e non può ritardare né far
fallire la spazzata (test per ordine nel sorgente, per assenza dentro `poll`); ⚠ è **inerte** finché
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` non sono nel `.env`, e lo dichiara nel log. ⟨6⟩ **IL SECONDO
INGRESSO — perdita giornaliera realizzata a −$100 — DA R10 CHIUDE ANCHE LE POSIZIONI**:
`chiusura-di-emergenza.js` (puro, zero `require`) classifica in **coppie a merge · gambe scoperte vendute
attraversando · gambe sotto il minimo LASCIATE e dichiarate**, e agent43 **deposita**
`data/chiusura-emergenza-richiesta.json` **senza eseguire** — a eseguire è **agent41**; ⚠ il presidio dei
60 minuti sta dietro `botAttivo()`, cioè **non gira a bot FERMO**, che è lo stato che il kill produce; ⚠ il
drawdown continua a NON toccare le posizioni, perché misura un **prezzo**, che può rientrare.

**⚠ OGGI NESSUN PROCESSO SORVEGLIA IL BATTITO DI agent40**, ed è una conseguenza voluta della rimozione di
agent37 (§5 p.63): **agent37 guardava i processi, agent43 guarda il capitale**. Se agent40 si blocca con
ordini a riposo, a toglierli restano la **GTD nativa** del venue e agent43 sul lato economico.

**Fuori da pm2, a richiesta — `node scripts/monitor-reti-dei-21.js`** (`--watch`, `--json`): confronta il
board col **Setting Consensus** dei 21 wallet vincenti. **Non filtra sul montepremi**, e una scadenza non
leggibile **non** entra fra i coerenti. Sola lettura dimostrata da un test.

## 4 · STATO ATTUALE DEL SISTEMA

**Ogni numero qui sotto è letto dal codice/stato reali** (per cosa fa il bot, v. §1).

### 4.1 · Il motore di piazzamento — `lib/maker/motore-unico.js`

*(Testo integrale prima della potatura del 23/08: `docs/storia-per-sezione.md`.)*

Un profilo solo (Safe/Risk aboliti: la formula del venue è una curva continua e non conosce bucket; nessun
`if (profilo)` nel repo). **Le cinque regole, nell'ordine in cui si applicano:**

1. **Mai primo sul book** — vincolo assoluto, slegato dal punteggio. Se «un tick dietro il migliore» e
   «dentro la banda» si contraddicono, **vince la banda**: ci si ferma al suo bordo e il verdetto porta
   `onTop:true` perché il caso sia visibile. `top-of-book.othersLadder` sottrae i nostri ordini, o il
   motore inseguirebbe se stesso. **Due sole eccezioni**, entrambe omissioni puntuali del flag `inCoda` su
   UNA gamba, entrambe condizionate, e un test ne conta **esattamente due**: la controparte quando la banda
   sta **sotto il carico** (§5 p.59-60) e la gamba contraria del rimasuglio da chiudere (§5 p.66).
2. **Depth floor adattivo** — `DEPTH_FLOOR_PCT_OF_AVG = 0,10` della liquidità altrui media in banda di quel
   mercato specifico, non un dollaro fisso. Ripiego $15 per i mercati senza storico.
3. **Poi ci si ferma** — conseguenza del quadratico: soddisfatte 1 e 2 il livello trovato è già quello col
   punteggio più alto. Non esiste un controllo separato di volatilità o spread.
4. **Lato singolo deciso dalla formula, non da un timer** — dentro `[0,10 · 0,90]` un lato solo matura
   comunque un terzo e si tiene; fuori matura **zero** e si cancella subito. Il mid si rilegge a ogni ciclo.
5. **Tetto di capitale per mercato** — vedi 4.2. È gestione del rischio, deliberatamente fuori dal calcolo
   del punteggio.

**Soli sul lato ⇒ bordo ESTERNO della banda** (`fallback-alone-bordo-esterno`): senza concorrenti si è
primi per forza, quindi si sta al prezzo **peggiore che resta premiante**. Banda senza prezzi validi ⇒ **non
si quota**. Appena compare un concorrente si torna a un tick dietro.

**⚠ IL BORDO NUDO NON SI USA PIÙ: c'è un MARGINE, ed è adattivo** (§5-bis p.164).
`distanza-obiettivo.bordiConMargine` rientra il bersaglio di **`max(1 tick, 0,22 × v)`** dal bordo — 0,22 è
**esattamente un tick sulla banda modale** (1,0¢ su 4,5¢), quindi il margine vale lo stesso numero di
centesimi su qualunque griglia. È anche la **soglia bassa di uno Schmitt trigger**: si esce a
`v + hysteresisTicks` e si **rientra** a `v − margine`. **⚠ Il margine non può mai avvicinare al mid oltre
il prezzo di coda** (`Math.min` col prezzo che «mai primo sul libro» ha già scelto; quando cede è
dichiarato, `margineCeduto`); bordi che si incrociano ⇒ margine **non applicato** e dichiarato. **⚠ E IL
MARGINE SI FERMA A METÀ BANDA** (`FRAZIONE_MASSIMA_DEL_RAGGIO = 0,5`, costante di sorgente, **nessun env**),
o l'ordine starebbe nella metà **interna**; su una banda più stretta di due tick il margine va a **zero** e
il bordo torna nudo: è la risposta onesta.

**Fine scala**: sotto 3¢ o sopra 97¢ un mercato sta risolvendo e non si quota (`end-of-scale.js`, soglie da
`.env` rilette a ogni chiamata; un valore che non si capisce viene **scartato** in favore del difetto — un
`.env` sbagliato non può spegnere una protezione). La chiamano quattro moduli.

**Mid stantio**: oltre **120 s** di cecità l'ordine si **cancella** (`mid-stantio.js`, clamp `[5 s, 120 s]`).
⚠ A 20 s cancellava ciò che `decideReprice` non era disposto a riprezzare prima di 60 s. L'orologio si
azzera **solo su una lettura buona**, e una cancellazione fallita NON lo azzera. Tre cause distinte in
audit — `cecita-timeout-{mid-stantio|nessun-libro|eta-ignota}`.

**🔁 IL PAVIMENTO DI PROFONDITÀ NON GIUDICA UN RINNOVO** (regola del 16/08; **il ponte fra `valutaMercato` e
`trovaLivello` era tagliato e fu ricablato il 23/08** — referto e le 63 morti per GTD, $862,58 fuori dal
libro: `docs/referti-difetti-corretti.md`). `auto-reprice` costruisce la prova
(`esenzione-rinnovo.provaRinnovo`) e la passa come `rinnovo:` a `valutaMercato`, che la **inoltra a
`trovaLivello`** — l'unica funzione che sa esentare.
**⚠ MONOTONA PER COSTRUZIONE, e non per taratura**: si valuta col pavimento **PIENO** e **solo se cade** si
rivaluta con l'esenzione (inoltrare e basta fu misurato a secco e **bocciato**: recuperava 1 rifiuto e ne
creava 4).
**⚠ UN RINNOVO NON HA BISOGNO DI UN LIVELLO NUOVO: HA BISOGNO DI TENERE IL SUO.** Se il pavimento era
soddisfatto e a scartare sono stati **solo** i prezzi, il verdetto è ammesso e il prezzo è quello che
l'ordine **ha già** (`prezzoDiRiferimento: true`, `level: null`) — mai un livello più caro.
**⚠ IL PREZZO DI RIFERIMENTO È QUELLO CHE PARTE**, non `order.price`: `prezzoCheParte`, un numero solo,
letto dal tetto per mercato **e** dalla prova — o un **inseguimento al rialzo** si dichiarerebbe rinnovo
passando con **più** nozionale a riposo. ⚠ Su una gamba **SELL** `prezzoMassimo` si **specchia**.
**⚠ ESENTA QUEL PAVIMENTO E BASTA**: «mai primo sul libro», tetto per mercato, banda, fine scala, mid
stantio, KILL, rate limit e tetto per ordine restano identici e **asseriti**. **LA PROVA**:
`rinnovo-sotto-il-pavimento.test.js` (22/22, proprietà non sorgente; monotonia su **252 configurazioni**).
⚠ `scripts/dipendenze-scollegate.js` non può vedere un ponte così (§5.2 p.66).

**📣 UN CICLO CHE PERDE ORDINI PER GTD LO DICHIARA**: **una riga sola** per ciclo,
`outcome:'anomalia-scadenze-senza-rinnovo'`, `anomalia:true`, con numero, nozionale, mercati, `perGate` e
gli `orderId`. `scaduto-senza-rinnovo` c'era già e non ha avvisato nessuno: **il degrado non era silenzioso
per mancanza di righe, ma perché nessuna riga diceva QUANTO**. ⚠ **Referto, non gate.** ⚠ Si scrive **solo
se qualcuno è morto in quel giro** (asserito per assenza). ⚠ `senzaNozionale` conta a parte chi non si è
potuto misurare: «non ho letto» non è «non c'è».

**Cadenza di reprice adattiva per mercato** (`cadenza-adattiva.js`): l'escursione del mid su 15 minuti
diventa tick/ora e da lì tre classi — veloce 1 s, media 5 s, lenta 10 s (chiamate al venue −37,9%). **Non
abbassa nessuna soglia** (`minMoveCents`, `hysteresisTicks`, `confirmSamples`, `minIntervalMs` restano dov'
erano): guardare più spesso non riprezza di più. Misura assente ⇒ cadenza di difetto; la decisione guarda
anche l'**istante dell'ultimo book**.

### 4.1-bis · Il riprezzo guarda il BOOK, non solo il mid — R4, 18 agosto 2026

*(Testo integrale: `docs/storia-per-sezione.md`.)*

**IL TRIGGER 4 VEDE LA DEGRADAZIONE PARZIALE DEL BOOK**, che il TRIGGER 3 («siamo diventati i primi del
nostro lato») non vedeva — un taker mangia tre livelli su cinque, il mid non si muove, e il rischio di
essere riempiti sale proprio mentre il prezzo sta per muoversi contro. `auto-reprice.js:681` →
`book-erosion`.

| cosa | valore |
|---|---|
| criterio | **solo erosione RELATIVA**: < 40% della baseline, 2 letture, isteresi 40/60 sulla baseline **congelata** (`book-erosion.updateErosion`) |
| buttato | **«è sparito un livello»** — 1.690 scatti su 1.775 venivano da lì, e su un feed troncato a 3 livelli è rumore |
| freno | **60 s** (non i 30 di difetto): è il rail del venue, 40 invii/60 s — `sospensione-erosione.FRENO_MS`, **iniettato** |
| lato | **SELL esclusi**, come il TRIGGER 3 |
| azione | **cancella e resta fuori**, tetto **5 minuti**, poi rientra e lo **dichiara** |

**⚠ NON PRODUCE MAI UN PREZZO**: può solo cancellare — banda, «mai primo», tetti e scala d'urgenza restano
identici. **⚠ SENZA IL REGISTRO SU DISCO LA REGOLA NON ESISTEREBBE**: a cancellare è agent40, a rimettere
la gamba è agent41, la cui scala parte **subito**. **⚠ SE LA SOSPENSIONE NON SI SCRIVE, NON SI CANCELLA**
(si pagherebbe la perdita di coda senza comprare la protezione). **⚠ FAIL-APERTO, contro la regola generale
del repo**: registro illeggibile ⇒ nessuna sospensione ⇒ la gamba torna a libro, perché un file che non si
legge non deve poter tenere il bot fuori dal libro per sempre. La misura del 17/08 è in
`docs/misure-e-tarature.md`; ciò che resta aperto è §5.2 p.43.

### 4.2 · I tetti di capitale — `lib/rewards/concentration.js`, UNA fonte, importata

**Nessun numero cablato: il tetto DERIVA da `f_min`.**

```
tetto per mercato = pavimentoPremiante(SCAGLIONE_FINANZIABILE) = 50 × 0,98 × 1,25   = $61,25
                    ⇒ f_min NON è più l'ingresso: è la conseguenza, e vale 0,32
tetto per ordine  = tetto × 0,97 / 0,98 + $5                                         = $65,63
pavimento premiante(minSize) = minSize × 0,98 × 1,25   ⇒ 20/50/100/200 = $24,50/$61,25/$122,50/$245
tetto EFFETTIVO per ordine = min(safety.maxOrderNotionalUsd $80, $65,63)             = $65,63
```

**⚠ IL TETTO PER ORDINE NON È «METÀ DEL MERCATO»** (§5-bis p.164): è dimensionato sulla **gamba peggiore
quotabile** — su un mercato sbilanciato la gamba cara vale fino al `PREZZO_MASSIMO_QUOTABILE = 0,97` del
costo della coppia, cioè il **99%** del capitale del mercato. Era la causa a monte misurata di
`coppia-non-atomica`. Per conseguenza **derivata** la finestra di mid è `[0,01 · 0,99]`, cioè smette di
essere un cancello.

- **Il numero di mercati è una CONSEGUENZA** (`capitale ÷ tetto`), non un parametro: capitale che cresce si
  spalma su **più mercati**, non ingrossa la size (una frazione pura `tetto = C×k` fa l'opposto, §5 p.107).
- `capPerMarketUsd(capitale)` **non restituisce mai `null`** (varrebbe «nessun tetto», cioè fail-open) e può
  solo **stringere**. **Undici consumatori lo IMPORTANO**, nessuno lo ridichiara
  (`netto-centralizzato.test.js` verifica gli import **per nome**; **D1** sorveglia `MARKET_CAP_FIXED_USD`).
- **Un mercato sotto il pavimento premiante NON si quota**: sotto `min_incentive_size` il reward è **ZERO**.
- **⚠ Il tetto NON si può alzare per diversificare** (§5 p.117): a `f_min` 0,32 i mercati passabili
  **CALANO**. La leva è più capitale, non una manopola.

**🔓 IL TETTO DI ESPOSIZIONE NON PUÒ MURARE UNA GAMBA NUDA** (§5-bis p.168): `evaluateLimits` limite 2
confronta `openNotionalUsd + notional > cap`, che su chi **CHIUDE** è sbagliata **di segno** — terza
occorrenza della classe «regola nata per limitare l'APERTURA applicata a un'azione che non apre».
**⚠ NON È UNA DICHIARAZIONE DI CUI FIDARSI**: l'esenzione arriva già **provata** da
`esenzione-chiusura.provaChiusura` — la **stessa** funzione del tetto per ordine, importata e non ricopiata
(SELL entro il posseduto, BUY entro `manca`, dallo snapshot del venue); qualunque lettura mancante lascia il
tetto applicato, e si guarda `=== true`, mai la truthiness. **⚠ ESENTA QUESTO TETTO E BASTA**: tetto per
ordine, rate limit, perdita giornaliera, posizioni illeggibili, esposizione non misurabile, allowlist e
KILL restano davanti e **identici** (sei asserzioni). L'esenzione **si dichiara**
(`outcome: 'esenzione-esposizione-chiusura'`) e **non** si dichiara quando il tetto non stava mordendo.

**Tetto di ordini per finestra** (`data/safety-risk-limits.json`): **40 invii / 60 s**, con **quota 60/40**
— al più 24 posti alle aperture, **16 riservati a rinnovi e chiusure protettive**. Invariante difesa da un
test: `rateCap ≥ 2 × mercatiPerGiro` con almeno 8 posti di margine. Un'apertura rimandata è un **rinvio
dichiarato** (`rimandato-per-quota`), non un errore.

**I numeri correnti**: cap per ordine di safety **$80** · cap cumulativo di esposizione aperta **$2.400**
(dal 23/08, decisione dell'operatore, per reggere i 18 mercati di §4.13 su un soffitto di 19; conta i
**fill riconciliati**, non gli ordini a riposo) · **perdita giornaliera massima $100**, che è **il freno
vero** · **mercati per giro 10**, dichiarati in **un posto solo**
(`utilizzo-capitale.leggiMaxNuoviPerGiro`) e importati dal trigger.
**⚠⚠ IL CAP NON È UN PERMESSO, È UN BUDGET**: `realloc-cycle.js:242` fa `capitale = min(saldo, cap)`
**prima** del knapsack, quindi alzarlo è un **ordine di allocare di più**.
**⚠ Il cap non si abbassa «perché morda»**: il gate confronta `openNotionalUsd + notional` **anche sulle
APERTURE**, quindi un cap stretto smette di piazzare a metà strada (successo davvero a $150 il 16/08).
L'invariante giusta è **`cap ≥ esposizione massima raggiungibile`** = N coppie a riposo **più** il loro
completamento (§5.2 p.37), definita in un punto solo
(`concentration.esposizioneMassimaRaggiungibileUsd(N)`).
**⚠⚠ IL CAP HA UN SECONDO TETTO SOPRA DI SÉ, E VA MOSSO INSIEME**:
`lib/safety/risk-limits.HARD_CEILINGS.maxOpenNotionalUsd` (**$2.400** dal 23/08, era $2.000) è il tetto
**duro** di sorgente, e `clampNum` fa `min(disco, tetto duro)` **senza sollevare** — un cap versionato più
alto del tetto duro sarebbe in servizio al valore duro, cioè un numero deciso dall'operatore e
silenziosamente diverso da quello applicato. Si alza allo **stretto necessario**;
`lib/maker/cap-2400-e-slot.test.js` ② confronta disco e servizio e fallisce sul clamp.
**⚠⚠ E DAL 24/08 LA RELAZIONE È UN CANCELLO D'AVVIO, NON UN COMMENTO**: `lib/safety/invariante-cap-slot.js`
verifica `N × 2 × $61,25 ≤ min(cap versionato, HARD_CEILINGS.maxOpenNotionalUsd)` all'avvio di **agent40 e
agent41** — un modulo solo, chiamato da entrambi sotto la stessa guardia `require.main === module` che protegge
`main()`, così un test che *importa* l'agent non muore e il processo che *parte* non può saltarlo. Rotta ⇒
stderr con N, il prodotto, il cap versionato, il tetto duro e il cap effettivo, poi **exit**.
**⚠ LA CURA È ABBASSARE N, NON ALZARE IL CAP** (il cap è un budget: alzarlo è un ordine di allocare di più), e il
modulo non scrive niente. Oggi N=18 ⇒ $2.205 ≤ $2.400, **margine $195**; il massimo che il cap autorizza è **19**,
e **20 romperebbe** ($2.450).

**⚠ A $2.400 IL CAP NON È PIÙ UNA DIFESA**: vale il **161%** del capitale, e il `min` lo prende ormai
**sempre il saldo**. A limitare restano il saldo, il tetto per mercato, il numero di slot, e come **freni**
il **kill a −$100** e il **guardiano**.

**⚠ `data/safety-risk-limits.json` NON È GITIGNORED**: i cinque numeri che governano l'esposizione
vivevano solo sul disco di una macchina, e un ripristino da git li avrebbe riportati a valori diversi **in
silenzio**. **Una fonte sola versionata.** `limiti-versionati.test.js` fallisce se il file manca, se torna
in `.gitignore`, se manca un limite, se un valore supera il tetto duro, e — l'asserzione che conta — **se il
disco non coincide con il versionato**. Il lettore falliva già chiuso (`clampNum` marca `missing`,
`manual-order` rifiuta con `cap-missing`).

**⚠ La quota 60/40 sui volumi di oggi non morde mai** e va saputo (141 intent in 48 h, picco 18/min contro
24 posti; il rate limit del **venue** ha morso **una volta in 48 ore**). E `skip-rate-limited` in
`auto-reprice` **non è** il rate limit del venue: è `minIntervalMs`, l'anti-churn **locale** di 30 s, che
per costruzione non può costare un ordine. La causa vera per cui un rinnovo muore è `motore-non-conforme`.

### 4.3 · La griglia del piano — `lib/rewards/allocator.js`

`unitUsd` (granularità in dollari del knapsack) è il **minimo** fra `round(budget/50)` e
`floor(tetto_per_mercato / LIVELLI_MINIMI_PER_MERCATO)`, con **8 livelli minimi per mercato**. Può solo
**infittire** la griglia, mai diradarla (è un `Math.min`), e vale **solo per il pianificatore**: chi
passa `cfg.unitUsd` esplicito — ogni driver di backtest — non è toccato, quindi le serie storiche
restano confrontabili numero per numero.

**⚠ Senza questo limite il tetto è IRRAGGIUNGIBILE e il piano si autoblocca.** È il deadlock del
13 agosto: con `unitUsd` legato solo al budget, `floor(32,67/12) = 2` livelli ⇒ massimo allocabile
**$24,00** contro un pavimento di $24,50 ⇒ **ogni riga di ogni piano rifiutata, per sempre**. Vedi
§5 punto 120: era un **dente di sega**, cioè peggiorava crescendo il capitale.

### 4.4 · Selezione e filtri del piano

*(Testo integrale: `docs/storia-per-sezione.md`.)*

| filtro | regola |
|---|---|
| **orizzonte** (`horizon.js`) | `[MIN 0,50 g · MAX 150 g]`, confini **inclusivi da entrambi i lati**; il pavimento in ore (**12 h**) è **derivato** in `market-validity` e `risk-classifier`, non ripetuto. **Scadenza non determinabile ⇒ ESCLUDE**. ⚠ **È il filtro che taglia di più** (78 su 102), e il gradino è tutto fra 12 h e 18 h — §5 p.129 prima di toccarlo |
| **quota coda lunga** | il capitale oltre `LONG_TAIL_DAYS 7` non supera il **12%** del piano (⚠ **in servizio 0,50** via env, §5.2 p.65). **Due passate**: la fascia corta gira col budget pieno, la coda riceve `S·q/(1−q)`; fascia corta vuota ⇒ la coda non ottiene niente |
| **profondità** | **scala la size**, non toglie il mercato: `S_max = 1,5 · cQ`. Esclude solo dove **nessuna size piazzabile** regge (`escluso-troppo-sottile` / `escluso-sotto-minimo`). ⚠ **VINCOLO ASSOLUTO: mai forzare la size al minimo del venue oltre la quota sicura**, ed è strutturale |
| **quotabilità** | `planBehindBest`, **la stessa funzione del piazzamento**, su **entrambi** i lati. Fail-open: dati mancanti ⇒ `ignota`, il mercato resta. «Nessun concorrente» non è un dato mancante: è il ramo «soli» |
| **tetto di credibilità** | `maxCredibleShare = 0,60` applicato per **LIVELLO** della curva; una definizione sola, importata da entrambe le parti |
| **book vuoto verificato** | `capVuotiFrac = 0,30` del lordo pesato. Uno **0 misurato** (≥10 campioni ws su book fresco) non è un buco: un dato mancante è `null` e **non diventa mai zero** |
| **peso di posizione** | il lordo è pesato col punteggio alla distanza **reale**, non al ceiling. Acceso **solo** nel pianificatore |

**`ignota` non esclude mai** — vale per profondità, quotabilità e (fino al filtro d'orizzonte) scadenza.
**Una sola formula capitale→share**: `size-da-capitale.js`, `Q = C/(p_yes+p_no)`; **il mid non decide più
chi qualifica**, e il ripiego senza costo della coppia usa il tipico **0,98** dichiarandolo
(`modello: 'ripiego-tipico'`), mai la vecchia `(C/2)/mid`. **⚠ Il tetto è un SOFFITTO, non l'allocazione**:
con la griglia di 4.3 le righe arrivano al tetto e `f_min` ≈ 0,61.

### 4.5 · Il capitale al lavoro — `utilizzo-capitale.js` + `capitale-al-lavoro.js`

```
totale   = saldo + posizioni          ← e NIENTE altro
libero   = max(0, saldo − ordiniARiposo)
alLavoro = totale − libero            ← DERIVATO per differenza, mai risommato
obiettivo = 0,95      (leggiTarget, unica fonte)
```

Un BUY a riposo **non abbassa il saldo** su questo venue (l'ordine è firmato off-chain e il collaterale
resta nel wallet fino al match): `ordiniARiposo` è un **sottoinsieme** di `saldo + posizioni`, mai un
addendo — sommarlo era il doppio conteggio del 9 agosto (+16,1%, §5 p.58), che oltre a mentire **allargava
un limite di rischio**. `misuraDopo` **non accetta più il saldo come parametro**: l'errore non è più
esprimibile. `riconcilia()` ferma il giro (`fermato-capitale-incoerente`) se due letture del saldo divergono
oltre **max(2%, $5)**; **una lettura mancante non è una lettura concorde**, ma nemmeno una divergenza.

**Non misurabile non è zero**, mai: un saldo illeggibile trattato come 0 direbbe «utilizzo 100%» proprio
quando il capitale è fermo. Sotto l'**80% per 30 minuti** si scrive la **ripartizione del fermo in
dollari**, attribuita **da monte a valle** (piano senza righe → non quotabili → tetto pieno → quota →
rifiuti del venue) così lo stesso dollaro non è contato due volte, e ciò che nessuno ha misurato resta
**`non attribuito`: una voce, non un arrotondamento nascosto**. Si vede su
`GET /api/maker/utilizzo-capitale`, nel giornale (`op: capitale-al-lavoro`) e a ogni ciclo di agent41.

### 4.6 · Il ciclo di vita di una posizione

*(Il **dettaglio integrale** di questa sezione — tutte le clausole «⚠ perché» — è in
`docs/storia-per-sezione.md`; le misure in `docs/misure-e-tarature.md`; i referti dei difetti corretti in
`docs/referti-difetti-corretti.md`. Qui restano le regole e i numeri.)*

**Fill ⇒ modalità chiusura** (`modalita-chiusura.js`): timestamp scritto una volta sola e persistito, le
share non fillate **spariscono in ogni caso**, poi **PIANO A** — il taker immediato, che è il Livello 1 e
non un secondo meccanismo — e **solo se fallisce** le regole di chiusura. Parziale e totale sono lo
**stesso percorso**: la ramificazione è nei dati, non in un `if`.

**⚠ FILL PARZIALE: IL RESIDUO SI CANCELLA SEMPRE E SUBITO** (17/08, decisione dell'operatore): esce dal
libro **a ogni giro** finché è là. Guardia: **senza `deps.chiusura` il comportamento resta quello di
prima**. Esito `modalita-chiusura-residuo-non-fillato-cancellato`. **Le liste non sono ricopiate.**

**La gerarchia del merge, senza scorciatoie.** `completaCoppia` è chiamata da **tutti** i rami di
`runAutoCloseCycle` — `already-covered`, `close-at-market`, uscita ordinaria e **`skip`** — tranne i tre in
cui manca un ingresso (`no-position`, `no-entry-price`, `rules-unreadable`), che lo **dichiarano**
(`merge-saltato-senza-ingressi`) invece di tacere.

| # | stadio | tetto |
|---|---|---|
| 0 | **merge on-chain** se la coppia è già completa | rende **$1/share subito**, gas del relayer, zero slippage |
| 1 | Livello 1 — taker sull'altro lato | coppia ≤ **101¢** |
| 2 | Livello 2 — maker a riposo, attesa **30 min**, **bersaglio su disco**; ai cicli dopo si **aggiunge** la differenza, mai si sostituisce l'ordine vivo (aprirebbe una finestra di scoperto totale) | coppia ≤ 101¢ |
| 3 | chiusura rapida: taker fin dove il book copre + limit per il resto | coppia ≤ **101¢** |
| 4 | riposizionamento scoperto: SELL a **+1% dal carico**, dentro banda e **mai sotto il carico**, + BUY sulla controparte | coppia ≤ 101¢ |

**⚠ IL PAVIMENTO DELLA SCALA DEV'ESSERE UN PREZZO ESPRIMIBILE**: `pavimentoConcesso` restituisce **due
numeri** — `pavimento` (esatto, per **confrontare**) e `pavimentoGriglia` (per **prezzare**). **Un solo
arrotondamento in tutto il repo**, e sta lì: `exit-plan` lo **legge** e non lo ricalcola (un test pretende
che sia uno). **In su**, o si venderebbe sotto il pavimento della scala del §7. **Il confronto resta sul
numero esatto**: spostarlo cambierebbe chi passa, cioè una decisione di rischio.

**🚪 L'USCITA PUÒ GUARDARE FUORI BANDA QUANDO LA COPPIA È IMPOSSIBILE** (22/08, decisione dell'operatore):
gamba scoperta **e** `carico + ask sorella` oltre **101¢** ⇒ prezzo =
`max(pavimento del gradino, min(obiettivo, miglior bid))`, la **stessa** aritmetica di `inseguiIlBid`.
**⚠ IL MERGE VIENE PRIMA, SEMPRE, ED È SCRITTO** (`sizeAltroLato > 0` ⇒ si fonde; non letta ⇒ niente
deroga). **⚠ IL TAPPO DEL 5% (R7) E LA SCALA DI §7 NON SI TOCCANO**: il pavimento è un `Math.max`, quindi
si sceglie solo un prezzo che la scala **già consentiva**; se resta sopra il bid l'ordine sta a riposo fuori
banda e non si riempie — **è la risposta voluta**. **⚠ `band-exit` non giudica un'uscita fuori banda
voluta** (venderebbe al bid, sotto il pavimento): il trigger 1 si salta e si dichiara, **il tetto di attesa
di 24 h resta intatto**. **⚠ E NON DICHIARA `inCoda`**, o `manual-order` riporterebbe l'uscita dentro banda
riassegnando `price = q.price` — **quarta** omissione condizionata, contata per nome da
`risposta-al-fill.test.js`. **⚠ MONOTONO, OPT-IN, fail-closed** su ogni ingresso.

**⚠ IL LIVELLO 0 SI VALUTA PRIMA DI QUALUNQUE GUARDIA SUL PREZZO** (R8): il conto di `manca` sta **sopra**
le due guardie (carico non leggibile, tetto non calcolabile), che parlano del **secondo lato**; chi
**compra** pretende ancora carico e tetto, identici. Monotono.

**Un obbligo di esito** si apre nella stessa istruzione che scrive la decisione: due punti di flush che
nessun `continue` può saltare, e `merge-esito-mancante` per chi sfugge. **Ogni** esito di `registraCoppia`
scrive una riga, `non-applicabile` e `in-attesa` compresi.

**Tetto della coppia 101¢, e adesso è UNO SOLO.** `MERGE_MIN_MARGIN_CENTS` è **derivato** (`100 − 101 =
−1`); `MAKER_TETTO_COPPIA_CENTS` è un env con clamp `[100 · 200]`, asserito in **un punto solo**.

**💰 LA PRESA DI PROFITTO DECIDE SUL BID CAMMINATO, MAI SUL MID** (`presa-di-profitto.js`, puro, dopo le
guardie su mercato chiuso e **prima** di `already-covered`): incassare al bid batte completare la coppia
esattamente quando `bid + ask > 1` — **`coppia-battuta`** (`bid + ask > 1 + m`) e **`coppia-bloccata`**
(coppia oltre 101¢: `bid > carico + m`), `MARGINE_CENTS = 1` **per share e non tick**. **SI ATTRAVERSA, NON
SI INSEGUE.** **TUTTA LA SIZE O NIENTE**, o resta un residuo sotto il minimo. **⚠ Fail-closed** su ask,
scala e carico. **⚠ `close-at-market` non chiama `provaCoppia` quando il trigger è la presa di profitto.**

**⚠ E LA SCALA DEVE ARRIVARE AL PREZZO, non al permesso** (§5-bis p.138): `already-covered` **ricalcola** il
prezzo a ogni giro e dal gradino 1 in su **insegue il miglior ask** fermandosi al pavimento — **vince il più
stretto**, e si riduce soltanto (almeno un tick). **`planExit` produce un PAVIMENTO, non un prezzo.**

**🏳️ L'ABBANDONO — R6 LETTA COME CANCELLO** (23/08, decisione dell'operatore, `abbandono-posizione.js`,
puro): posizione **scoperta** con `valoreResiduo < SOGLIA` **E** `costoUscita ≥ valoreResiduo` ⇒
**ABBANDONATA** — esce dal ciclo di uscita, **libera lo slot**, e **non si cancella nulla al venue e non si
vende**. `valoreResiduo` = **bid CAMMINATO** per l'INTERA size, mai `size × mid`; `costoUscita` =
`min(vendita, coppia)` — **⚠⚠ sul CLOB le due vie costano identico** (`askAltroLato = 1 − bidMioLato`), e il
`min` resta scritto perché è l'unico punto che se ne accorgerebbe se il venue disaccoppiasse i libri.
**SOGLIA DERIVATA**: `PERDITA_MAX_FRAZIONE × MARKET_CAP_FIXED_USD = 0,05 × $61,25 =` **$3,0625**, entrambe
**importate**. **⚠ NON SPARISCE DAI CONTI**: abbandonare è smettere di **AGIRE**, non di **CONTARE**.
**⚠ NON SPEGNE L'ANOMALIA DELLE QUATTRO ORE** (il blocco sta **DOPO** `scoperto-oltre-soglia-grave`, e un
test diventa rosso se lo si inverte); `posizione-abbandonata` si scrive **a ogni giro**. **⚠ LA COPPIA
BATTE SEMPRE L'ABBANDONO**; `sizeAltroLato` non letta ⇒ **non giudicabile**. **⚠ ASIMMETRICO**: si entra con
**2 osservazioni contigue** (≤ 5 min), si esce con **una**. **⚠ LO SLOT SI LIBERA SOLO SE OGNI POSIZIONE
DEL MERCATO È ABBANDONATA**; §4.8 non è toccata. **⚠ REGISTRO SU DISCO**
(`data/posizioni-abbandonate.json`): lo scrive **agent40**, lo legge **agent41**, fail-closed nei due versi.

**⏳ GTD: 33 MINUTI SULLA CORSIA DI CHIUSURA, 23 SU QUELLA DI QUOTAZIONE** (23/08).
`GTD_CHIUSURA_SECONDS = MERGE_WAIT_TIMEOUT_MIN × 60 + REFRESH_MARGIN_SECONDS = 1.980 s`, entrambe
**importate**. **⚠ IL VENUE NON SA ESTENDERE UN ORDINE** (expiration dentro la struct EIP-712 firmata;
nessun `modify`/`amend`/`extend` nei due SDK). **⚠ LA QUOTAZIONE NON SI TOCCA**: il premio non conosce la
coda, e il tetto di 30 min di `ripristino-gambe` sta sopra la GTD *della quotazione*. **Nessun ordine di
APERTURA è toccato** (`riposizionaDopoChiusura` escluso e dichiarato); `tooClose` resta davanti. **⚠ IL
PUNTO UNICO È `chiudendo(spec)`, NON `piazzaChiudendo`**: delle **cinque** chiamate a `deps.placeOrder`
**una sola** passa da `piazzaChiudendo`.

**🔒 IL PREZZO DECISO DALLA SCALA È VINCOLANTE — 24 agosto 2026, decisione dell'operatore**
(`lib/maker/ordini-di-uscita.js`, puro; il timbro sta in **un punto solo**, `auto-close.chiudendo`).
Un ordine di **USCITA** — il SELL sulla gamba scoperta e il BUY che completa la coppia — porta
`uscita: true` e `prezzoDeciso`, e da lì **nessun ramo può riscriverne il prezzo**: né la coda «mai
primi», né il ricalcolo dal mid vivo, né il rientro in banda. **⚠ `inCoda` NON si dichiara più su
nessuna chiusura, e a toglierlo è `chiudendo`, non i chiamanti**: il 24/08 il lato posseduto lo
dichiarava con una motivazione ragionevole («è un ordine che ASPETTA e matura premi»), vera finché la
scala sceglie un prezzo *dentro* la banda e falsa appena lo sceglie fuori — e `prezzo-in-coda` ha
riportato **0,495 → 0,288**, cioè 8,3× la concessione che §7 consente.
**⚠ L'AGGIUSTAMENTO SI CALCOLA COMUNQUE E NON SI APPLICA**: la proposta finisce a verbale con prezzo
deciso, prezzo proposto, delta e **nome del ramo** (`uscita-aggiustamento-rifiutato`). Non calcolarla
renderebbe di nuovo invisibile ciò che è rimasto invisibile sette ore.
**⚠ DUE CONTROLLI TERMINALI, un istante prima della POST**: ① il prezzo che parte dev'essere *ancora*
quello deciso, o l'ordine **non parte** (`uscita-prezzo-riscritto`); ② un BUY di completamento la cui
coppia — **ricalcolata sul prezzo di INVIO, non su quello di decisione** — superi il tetto **non
parte** (`uscita-coppia-oltre-il-tetto`). Il carico si legge dallo **snapshot del venue**, non da una
dichiarazione; fail-closed su ogni ingresso.
**⚠ `band-exit` NON SPOSTA UN'USCITA**, e lo legge da `data/ordini-di-uscita.json` (il venue non
conosce le nostre intenzioni). **Fail-closed: registro illeggibile ⇒ nessun ordine si sposta** — costa
il premio del rientro in banda, mai un dollaro. **⚠ IL RINNOVO GTD NON È TOCCATO**: a scadenza
imminente l'uscita si ri-piazza **allo stesso prezzo** (`uscita-rinnovo-gtd`), o la cura ucciderebbe
l'ordine in 23 minuti.
**⚠ E IL PAVIMENTO SI CONFRONTA CON LA SCALA, NON CON L'ORDINE VIVO**: `close-sell-floor` ha difeso
**6.337 volte** un ordine a 28,8¢ contro un pavimento di scala di 49,5¢ — un pavimento che protegge un
prezzo già sceso sotto di sé è un'eco. Adesso quando l'ordine vivo sta sotto il prezzo deciso si
**dichiara** (`uscitaSottoIlPavimento`); non si sposta, perché cancellare lascerebbe la gamba nuda.
**⚠ CONSEGUENZA DA SAPERE**: senza `inCoda`, «mai primo sul libro» **non si applica più a nessuna
uscita** — che per un'uscita è lo scopo (è lì per essere eseguita), ma è un allargamento reale
rispetto alle quattro omissioni puntuali di prima.

**🔢 E I MINIMI DEL VENUE SONO DUE, CON DUE NOMI** (`lib/maker/minimi-del-venue.js`, puro):
`rewards.min_size` è il **pavimento premiante** (50/20 sui mercati misurati) e dice «reward ZERO»;
`minimum_order_size` è il **minimo d'ordine** (**5**) e dice «il venue rifiuta». `rules.minSize` in
tutto il repo è il **primo**, e il percorso d'uscita lo leggeva come se fosse il secondo — agent40
scriveva «sotto il minimo del venue (50)» dove il venue dice 5. **Ogni decisione d'uscita legge il
minimo d'ordine; ogni decisione sul premio legge il pavimento premiante.**
**⚠ FAIL-CLOSED ALL'OPPOSTO, apposta**: minimo d'ordine illeggibile ⇒ il percorso d'uscita **non
indovina, non dichiara e NON marca R6** (`piazzabile: null`, mai `false`); pavimento illeggibile ⇒
`premiante: null`, perché è una domanda sul ricavo. **⚠ Oggi `minOrderSize` non è ancora popolato da
nessuno scrittore del catalogo** (il campo esiste, il valore è `null`): l'effetto in servizio è
«illeggibile ⇒ non si indovina», che è la risposta voluta — ed è la ragione per cui la marcatura R6
automatica **non è stata cablata**.

**⚠ AL GRADINO 3, SE LA COPPIA È SOTTO 101¢, SI COMPRA LA SORELLA E SI FONDE — NON SI VENDE**
(emendamento alla regola 7, 24 agosto 2026, in cima a questo file): il merge rende $1,00/share garantito,
la vendita del gradino 3 realizza una perdita. La vendita resta l'unica via **sopra** 101¢. Non è un
meccanismo nuovo: è l'ordine che i Livelli 0-1-2 di questa stessa tabella hanno già.

**La resa dopo 60 minuti** (`urgenza-scoperto.js`): gradino 1 a **30 min** (uscita fino al carico), gradino
2 a **60 min** ⇒ chiusura **peggiorativa**, gradino 3 a 240 min ⇒ anomalia grave. **⚠ LA CONCESSIONE È IL
5% DEL CARICO, E BASTA** (R7): **allarga un limite di rischio** (caso peggiore **$3,06** contro $0,63 di un
tick). **⚠ `concessioneTick` è il CANCELLO, non la quantità**, e `Infinity` resta fail-closed. **⚠ Sui
token economici non cambia niente**: a 9,5¢ la concessione si azzera sulla griglia e la gamba resta in
attesa invece di essere svenduta.

**La regola generale del lato scoperto** vale da **qualunque causa** e converge in **un punto solo** —
l'esito `rinuncia` di `completaCoppia`. Sotto il minimo del venue la quantità si **accumula** in
`data/residui-scoperti.json` per mercato/lato: **ultima osservazione + storia, MAI somma aritmetica** (la
size che arriva è `sizePosseduta`, già cumulativa). *(Il registro della **sorella** somma invece, ed è
giusto: lì ogni voce è un ordine NOSTRO.)* **Il minimo è del venue e per MERCATO** (20/50/100/200).

**Chiusura forzata a 3 ore** dalla risoluzione: il verdetto si calcola **prima** della guardia sui livelli
e l'esecuzione resta **dopo** le cancellazioni. Scadenza da **board ∪ catalogo di ripiego ∪ venue**. Una
coppia **completa** non si forza.

**Le chiusure sono esenti dal tetto per ordine**, e l'esenzione è una **prova rifatta sull'ordine esatto**
contro lo snapshot posizioni (SELL ≤ share possedute, BUY ≤ `manca`). Qualunque lettura mancante lascia il
tetto applicato, e **il tetto di safety non è mai esentato**. **Una sola aritmetica per due cinture**
(`prova-riduzione.js`, importato dal GATE 4 e dall'adapter). **I percorsi taker non mirano ai propri
ordini** (`othersLadder`): la self-trade prevention del CLOB non è documentata, quindi non ci si conta.

**Gamba orfana**: al rinnovo GTD, una gamba sola + zero posizioni ⇒ si **cancella** invece di rinnovare, e
il mercato torna da ripianificare. **Conferma in due osservazioni** (60 s): la prima **arma soltanto**. Il
discriminante è l'**asimmetria**, non lo zero.

**Riprezzo atomico**: `replaceManualOrder` ha **cinque** precontrolli prima della cancellazione — kill,
orologio del mercato, guard condiviso sul prezzo, **tetto per ordine**, **chiave di idempotenza** — tutti
con `oldCancelled:false`, e **nessuna costante nuova**. I tre percorsi di cancellazione **voluta**
(mai-primo, mid stantio, fine vita) non passano di qui. **Piazzamento di coppia atomico in PRECONTROLLO**:
**entrambe** le gambe valutate con `evaluateManualCapGate` — la stessa funzione che poi rifiuterebbe, lo
stesso `caps` — prima di inviarne una; una fuori ⇒ **zero invii**, `gate: coppia-non-atomica`. **Si
precontrolla ciò che si può sapere prima, si ripristina ciò che si scopre dopo**; le **chiusure sono esenti
per costruzione**.

### 4.7 · Scoperta e feed

*(Testo integrale: `docs/storia-per-sezione.md`.)*

**agent24** ogni **15 minuti esatti**: dorme il *resto* del periodo (pavimento 60 s) e **cronometra** la
fase di profondità. **`REWARD_MAX_CLOB_MARKETS = 300` dal 21/08** (era 150), e il numero viene dal
cronometro: libri in **blocco** (`POST /books`) ⇒ 1,40-2,47 s/mercato ⇒ 300 in 7,0-12,4 min; **400
sforerebbe**. ⚠ **IL COLLO NON SONO I LIBRI, È `MAX_RPS = 1.5`**: la coda `httpGet` è SERIALIZZATA (sei
chiamate per mercato a 667 ms l'una contro un `GET /book` da 24-152 ms) — chi vuole andare oltre 300 guardi
`MAX_RPS`, non il batch. ⚠ **UN LIBRO CHE MANCA ESCLUDE IL MERCATO, RUMOROSAMENTE**: un `status !== 200`
restituiva `emptyBook:true, Qmin:0`, cioè concorrenza zero, cioè la quota stimata MASSIMA — un mercato non
letto si presentava come **il migliore del board**; `analizzaLibro` distingue `assente` da `emptyBook`.
`ETA_BOARD_MAX_MS = 25 min`. ⚠ **Il costo di una scansione si stima sugli elementi che PROCESSA, non su
quelli che sopravvivono ai filtri a valle** (fattore **3,5** fra i due numeri, e bastò a fermare il
capitale): una finestra temporale si tara su un **cronometro**.

**La scadenza ha una fonte sola: il venue**, col board come riscontro. Il CLOB **tronca a mezzanotte UTC**,
quindi è per costruzione mai più tardi di Gamma. Divergenza > 24 h, o Gamma prima del CLOB > 1 h ⇒ mercato
**escluso a monte** (`scadenza-discorde`); una lettura **mancante** invece non esclude — le due direzioni di
fallimento sono opposte apposta. Quando il troncamento è **DIMOSTRABILE**
(`troncaAMezzanotteUTC(gamma) === clob`) si usa l'ora vera di Gamma: è una **prova**, non tre indizi.

**Il feed di agent34 non è un anello chiuso**: si semina anche con i **CANDIDATI** (minSize compatibile col
tetto *di adesso* + orizzonte ≥ 18 h) e con i mercati con **posizione aperta**, non solo col piano. Tetto
della corsia **60**; ordine di sacrificio: righe del piano → quasi-vincitori → trattenuti → **candidati per
primi**. Board illeggibile ⇒ zero candidati. ⚠ È la corsia che oggi limita davvero cosa entra in piano:
§5.2 p.55.

### 4.8 · La regola di copertura, applicata in SEI punti

«**Board ∪ mercati dove il capitale è già esposto**, mai solo il board.» **Una** definizione
(`auto-reprice-config.liveMinMarketIds`), sei consumatori: gate live-min · sottoscrizione del book ·
composizione del board · lista dell'uscita automatica · scope del rinnovo · catalogo di ripiego. **Non
allarga il perimetro di rischio**: aggiunge solo mercati dove il capitale è **già** dentro. Fail-closed
ovunque, e subordinata all'interruttore generale.

**L'unione ha TRE componenti**: `abilitati ∪ posizioni ∪ mercati con ORDINI A RIPOSO` — la terza da
`lib/safety/venue-orders-snapshot.js` (`enabledDaOrdini`), e la stessa entra nello `scopeRinnovo` di
`auto-reprice`. Senza di essa, il 18/08 un mercato uscito dal board dieci minuti dopo aver ricevuto due
ordini veri ($56,36) è rimasto **senza nessuno che rinnovasse**: bot armato e fuori dal libro per 52 minuti.
**⚠ QUESTO SNAPSHOT FONDE PER MERCATO, NON SI SOVRASCRIVE**: le posizioni arrivano da una chiamata che
elenca tutto, quindi «assente» è una **prova**; gli ordini si leggono **un mercato per volta e solo per i
mercati in scope**, quindi «assente da questo giro» quasi sempre significa «non ho guardato». Lo scrittore
riceve `guardati` **e** `conOrdini`: non guardato ⇒ la voce resta, guardato e vuoto ⇒ la voce esce.
**⚠ Una memoria di processo non basta**: `deps.mercatiConOrdiniVivi` si sovrascrive intera a ogni giro, si
popola solo dopo quattro cancelli, e `cadenza-adattiva` fa `continue` **prima** del conteggio.
**⚠ LA VALVOLA PER-VOCE È UN BACKSTOP A 6 ORE, NON UN MECCANISMO**: la via d'uscita normale è
l'osservazione; a 30 minuti «perché sopra la GTD» riprodurrebbe il guasto con un'ora di ritardo.

**⚲ IL PERNO `MAKER_LIVE_MIN_MARKET` RESTRINGE, NON AGGIUNGE** (decisione dell'operatore): perno impostato
⇒ **il perimetro live-min È il perno, e nient'altro**; perno assente ⇒ è la lista dell'operatore. «Un
mercato solo» non era altrimenti esprimibile, perché **l'unione non si può svuotare finché una posizione
esiste**. **⚠ È MONOTONO PER COSTRUZIONE** (`{perno} ⊆ {perno} ∪ lista`), provato **esaustivamente su 80
combinazioni**. **⚠ CIÒ CHE SOSPENDE, e va saputo prima di armare**: con un perno attivo un mercato con
posizione **non riceve più il BUY di completamento coppia**; può ancora essere **USCITO** (l'eccezione di
riduzione è valutata *prima* dei rifiuti e passa dal token). Chi vuole quel BUY toglie il perno; non c'è una
terza via. **⚠ UNA SOLA ARITMETICA**: `adapter.perimetroLiveMin`, importata dal gate, da `manual-order` e
da `scripts/cli/mercati.js` — erano tre copie e divergevano già, sbagliando nella direzione che rassicura.
**⚠ IL PERNO VIVE NEL PROCESSO**: si legge da `/proc/<pid>/environ`, e cambiarlo richiede il riavvio **dal
file** e **insieme** (§5.1).

**⚠ E due filtri con lo STESSO predicato in fila sono una trappola** (§5 p.55): la soppressione per
profondità viveva in agent24 *e* in `buildCombined`, e l'eccezione «un mercato con capitale dentro non
sparisce» era scritta solo sulla seconda — la riga non arrivava mai fin lì. **Quando si esenta qualcosa da
un filtro, la domanda non è «l'eccezione è scritta?» ma «la riga arriva fin qui?».**
`punti-di-filtro.test.js` tiene la tabella dei sedici punti di filtro sui mercati.

### 4.9 · Merge on-chain e relayer

`CTF_RELAYER_ENABLED = **true**` (costante di sorgente, **non** una env). **Solo `mergePosition` ha un
chiamante** (`auto-close.fondiCoppia`, quando `decidiLivello` risponde `azione:'merge'`); `splitPosition` e
`redeemPosition` restano **esportate e mai invocate**. `verificaConfinamento()` ri-decodifica il batch prima
della firma e rifiuta qualunque target che non sia uno dei due adapter CTF; il controllo di coerenza
chiave↔credenziali vive **in un punto solo**, dentro il relayer. Fail-closed: `negRisk` non booleano, size
non finita, flag spento o qualunque eccezione ⇒ **non è successo niente**.
**Lo split non conviene MAI in questa strategia** (§5 p.48): rende 1 YES + 1 NO per **$1,00** mentre le due
gambe in banda costano **0,93-0,999**, e soprattutto **non mette niente sul libro** — non costa 3¢ in più,
**rinuncia all'intero ricavo**. **Nessun confronto di convenienza fra merge e vendita**: **coppia completa
⇒ merge**. Trappola: il relayer rifiuta le deadline corte — `DEADLINE_SEC = 900`.

### 4.10 · Registri, giornali, persistenza

*(Testo integrale: `docs/storia-per-sezione.md`.)*

`data/polymarket-maker-audit.jsonl` cresce di **67-82 MB/giorno** e **ruota sopra i 400 MB**, portandosi
nel file nuovo gli ultimi **64 MB** allineati a un a capo (~20 h): senza passato recente `origine-ordine`
dichiarerebbe ogni ordine «ignoto» e il reset si piazzerebbe **sopra i propri ordini**. Ordine: lucchetto →
ri-`stat` → `rename` → append; una riga può finire fuori ordine, **mai persa**. **Gli archivi non si
cancellano, non si potano, non scadono.** ⚠ La rotazione **non si innesca sotto un `*.test.js`**.
I giornali si leggono **incrementalmente** (`giornale-incrementale.js`; `readFileSync` costruisce UNA
stringa e V8 si ferma a ~512 MB): rotazione rilevata da **inode + dimensione + testa**, e l'ultima riga
senza `\n` è consegnata senza consumarla. ⚠ Su finestre grandi si usa `scartaCampi`, o si va in OOM.

**Persistono su disco** (provato con `kill -9` su nove processi): attese di merge · modalità chiusura col
bersaglio della sorella · residui scoperti e sotto soglia · tetti · gestione manuale · allowlist · catalogo
di ripiego · idempotenza · confronto reward · baseline e latch del guardiano · piano · `da-ripianificare`.
**Nessun buco strutturale.**

**Origine di un ordine**: `origine` **accanto** a `source` (`source` = quale corsia piazza, `origine` = se
dietro c'era una persona). Il reset di agent41 cancella **solo** ciò che è provatamente `auto`; manuale e
**ignoto** restano sul libro, e `auto-chiusura` non si tocca **per decisione**. Costanti **importate**.
**Idempotenza**: `sha256(userId|venue|tokenId|side|price|size)`, **nessuna componente temporale**; chi
supera un ordine **morto** eredita una chiave derivata, catena fino a **20.000** anelli. **La protezione
anti-doppio-invio non è il tetto**: è la verifica che il precedente sia morto sul venue, a **ogni anello**.
**La riconciliazione dei fill confronta grandezze OMOGENEE** (volume del venue per **token+lato** contro
quanto è già registrato per token+lato, e per **id-ordine-venue** nel ramo `size_matched`), mai contro una
singola `idempotencyKey` — o ogni ripiazzamento registra **intero** lo stesso volume come fill proprio
(§5 p.72: 2.790 share fantasma contro **zero** al venue).
**Il ledger si netta contro il venue**: uno snapshot `readable` che non elenca un token è **prova** che la
posizione è chiusa; assente, vecchio o illeggibile ⇒ **non si netta niente**. **Nessuna riga viene
cancellata**: append-only, `chiusaAlVenue` con la sua `esposizionePrimaUsd`.
**`skipped` non sparisce dal referto** (`saltati`, `motiviSaltati`): «0 piazzati, 0 rifiutati» descriveva un
**blocco totale** con la stessa riga con cui descriverebbe l'inazione.

### 4.11 · Backoff, rate limit, resilienza

429 ≠ 5xx: il 429 parte da 1 s e raddoppia (1→2→4), e **`Retry-After` vince** su qualunque progressione
(max 30 s). Dopo un esito **ambiguo** — la POST era partita — non si ritenta alla cieca: si interroga il
venue, e una verifica che non riesce vale «non ritentare» (fra due ordini e zero ordini il secondo errore
costa meno). `/positions` ha **5 tentativi, 1 s → 30 s, con jitter ±25%** (senza jitter ogni lettore
riparte dallo stesso istante dopo lo stesso 429); un 200 con un corpo che non è una lista **non si
ritenta**. **⚠ La soglia dei 180 s sullo snapshot NON è toccata**: impedisce di piazzare su una fotografia
vecchia delle posizioni.

I **sei piazzamenti di chiusura** riprovano fino a **3 volte** (`piazzaChiudendo`), ma **solo** se a
rifiutare è il venue e **mai su un esito ambiguo**; il KILL si rilegge **prima di ogni ritentativo**. **La
quotazione ordinaria non riprova**: un ordine di liquidità può aspettare il ciclo dopo, una posizione
scoperta no.

**pm2**: `min_uptime: 30 s` + `max_restarts: 500` sui processi critici, in **un punto solo** del config
(`RIAVVIO_ROBUSTO` + `PROCESSI_CRITICI`); `restart_delay` resta **per-agente** (6 valori distinti:
appiattirli sarebbe una regressione travestita da uniformità). ⚠ La politica diventa effettiva solo con
`pm2 restart agents/ecosystem.config.js --only <nome>`.

### 4.12 · Stima e consuntivo

**La stima è una QUANTITÀ, non un tasso fotografato**: `Σ(tasso × durata)`, campionata ogni **5 minuti** da
agent40 con **orologio e lucchetto propri**. Tre regole: un campione vale al più **due passi**, uno scoperto
**sottostima e lo dichiara** (`coperturaFrazione`), un tasso non finito **non si registra**.

**Il consuntivo è per GIORNO, non per mercato**: sulle righe REWARD `conditionId`, `title` e `slug` sono
vuoti (il venue paga un bonifico aggregato), e il totale **non viene diviso in proporzione** — sarebbe un
numero inventato con l'aspetto di una misura. Fonte: registro attività **pubblico** keyed sul **funder**
(le credenziali L2 sono dell'EOA: era un problema di **identità**, non di endpoint). Recupero **a ritroso**
fino a 30 giorni. Visibile su `GET /api/maker/registro-reward`.

### 4.13 · La selezione automatica dei mercati — `lib/maker/selezione-mercati.js` (15 agosto 2026)

*(Testo integrale prima della potatura del 23/08 e storia delle stesure precedenti:
`docs/storia-per-sezione.md`; le misure: `docs/misure-e-tarature.md`.)*

La lista dei mercati quotabili la riempie il bot, dentro i vincoli dell'operatore. **La decisione è PURA**
(zero `require`, un test lo asserisce); il cablaggio sta in `agent41` e passa dalle **stesse** funzioni di
prima — `preparaMercatoNuovo` per chi entra, `rilasciaDallaSelezione` → `setAutoReprice` per chi esce.

| | |
|---|---|
| **vincoli** | `rewardsMinSize ≤ 50` · **scadenza ≥ 24 h** e **≤ `MAX_HORIZON_DAYS`** · **niente famiglia meteo, SEMPRE E SENZA INTERRUTTORE** (`selezione-mercati.js:469`; nessun env lo condiziona — §5.2 p.69) · **max N ATTIVI dove N = `MAKER_MERCATI_CONTEMPORANEI`** (R1: **un `const MERCATI_CONTEMPORANEI` solo** in `agents/ecosystem.config.js`, referenziato dai blocchi `env` di agent41 **e agent40**, letto da `/proc`. **⚠⚠ DAL 24/08 NON HA DIFETTO**: `quanti-mercati.quantiMercati` **solleva** se manca, è vuota, non è un intero o cade fuori da `LIMITE_SLOT` 1..20, e `selezione-mercati` non contiene più nessun numero — `MAX_MERCATI_CONTEMPORANEI` e `QUOTA_SCAGLIONI` **tolti**, `quotaScaglioni`/`partizionaSlot`/`decidiSelezione` pretendono il numero e sollevano senza. Chi RACCONTA usa `provaQuantiMercati` (`ok:false`, non solleva); chi DECIDE usa `quantiMercati`. **In servizio 18**; il massimo che il cap autorizza è **19** e non è più un letterale: si calcola, ed è l'invariante d'avvio di §4.2 a fermarlo — il soffitto è quello che il **cap $2.400** autorizza (19×2×$61,25 = $2.327,50; a 20 sarebbero $2.450, no), il numero in servizio quello che la **cassa** consente (18×$61,25 = $1.102,50, residua $289,07 sopra il pavimento di $250). `quanti-mercati.js` importa il soffitto e un valore oltre il soffitto vale il **difetto, in silenzio**) · **book UTILIZZABILE** (v. sotto) · **composizione DERIVATA da N** (`quotaScaglioni`): N≥2 ⇒ **`round(N/3)` «basso» (≤20), almeno 1 e al più N−1, il resto «alto» (≤50)** — a **N=18 ⇒ 6 bassi + 12 alti**; N=1 ⇒ un secchio solo |
| **interruttore** | `data/selezione-mercati.json`, `scripts/cli/selezione.js {stato\|prova\|accendi\|spegni}`. Difetto **SPENTA**; file illeggibile ⇒ **spenta**. **ACCESA dal 15/08** |
| **quando gira** | a ogni ciclo 6 h **e** a ogni controllo del capitale fermo (120 s), **prima** del piano e prima di `decidiTrigger`, così un mercato che scade esce anche nei giri in cui il trigger non scatta |
| **classifica** | `levels[<capitale minimo>].grossRewardDay` (la stima che **il board ha già calcolato** con la formula del venue) → ripiego `rateOrdinamento` → `rewardsDailyRate`. **Non** il montepremi. Pareggio rotto sul `conditionId` |
| **il piano si restringe** | `restringiAllaSelezione` in `calcolaPianoFuoriProcesso`, il punto per cui **entrambi** i percorsi (6 h e mini-ciclo) sono coperti da una regola sola. **Interseca, non sostituisce**; intersezione vuota ⇒ vincolo **impossibile**, mai vincolo **assente** |

⚠ **Il vincolo delle 3 CATEGORIE è stato TOLTO** (15/08: teneva due slot sui mercati **peggiori**).
⚠ **168 → 24 h**: fra 48 e 168 h il board è VUOTO. ⚠ **Il filtro meteo toglie righe davvero solo da quando
l'orizzonte è 24 h**: una regola che vale «per conseguenza» va scritta esplicitamente, perché la
conseguenza cambia e la regola no.

**🌦️🔴 IL FILTRO METEO È INCONDIZIONATO E NON HA INTERRUTTORE** (misurato il 23/08 alle 15:35Z). Il
cancello è nudo a **`selezione-mercati.js:469`**; `filtroMeteoArmato` e `MAKER_FILTRO_METEO` **non
esistono** in nessun sorgente, nell'ecosystem, nel `.env` né in `/proc`. **⇒ ARMATO E NON SPEGNIBILE DA
CONFIGURAZIONE**: scrivere `MAKER_FILTRO_METEO: '0'` e riavviare non cambierebbe niente, e chi lo facesse
**crederebbe di aver disarmato**; disarmarlo vuol dire **scrivere il codice dell'interruttore**. **⚠ È la
causa misurata dello slot corto vuoto** (72 meteo su 75 mercati fra 24 e 48 h), **con zero falsi
positivi**: il filtro è **corretto**, è la decisione di escludere che è in discussione. **⚠ Chi misura usi
`selezione-mercati.eMeteo`, non un gemello.** Voce aperta e per intero: **§5.2 p.69**.

**📖 IL BOOK DEV'ESSERE UTILIZZABILE**, non «recente»: escluso solo chi ha **`needsResnapshot === true`** o
non ha proprio un book. **Nessuna soglia di età, di nessun tipo** — escludere `live !== true` buttava fuori
i mercati **TRANQUILLI**, che sono quelli che un maker di rewards vuole (14 book esclusi su 125 col
criterio vecchio, **1** col nuovo). **⚠ LA DOMANDA «SIAMO CIECHI?» NON APPARTIENE ALLA SELEZIONE**: la
risolve `mid-stantio` (§4.1) — due soglie sullo stesso fatto sarebbero due opinioni. **⚠ UNO SLOT VUOTO PER
SCARSITÀ SI DICHIARA** (`slotVuotiPerScarsita`, `postiNonAssegnati`, `scartatiPerComposizione`).

**🧊 «SLOT STERILE» — ARMATA dal 20/08** (`52c33f4`: soglia **22 min**, quarantena **180 min**, tetto **5
rilasci/ora**): libera uno slot che per **due osservazioni consecutive** non produce ordini. ⚠
**`SLOT_STERILE_ARMATO` ASSENTE ⇒ ARMATA** (giornale: `esito:'in-attesa'`/`'rilascia'` armata,
`'disarmato'` no). ⚠ **«Nessun ordine a libro» ha due cause opposte** — *sterile* e *svuotato da noi*:
un'osservazione non conta come sterile se ci sono state **cancellazioni nostre** nella finestra, e il
contatore si **azzera a ogni piazzamento riuscito**. ⚠ **LA QUARANTENA VIVE IN MEMORIA**: un riavvio di
agent41 la azzera insieme a `zeroDa` — non è un disarmo, ma è una **perdita del freno anti-churn**, e va
dichiarata da chi riavvia. ⚠ I mercati in quarantena non compaiono in nessuna lista di scarto (§5.2 p.62).
**PER DISARMARLA**: `SLOT_STERILE_ARMATO: '0'` + riavvio di agent41 **dal file**; solo il valore ESATTO
`'0'` disarma.

**🔄 LA ROTAZIONE ROVESCIA LA REGOLA DELLO SLOT** (16/08, decisione dell'operatore): un mercato che riceve
un fill — **totale o parziale** — **esce dal conteggio degli N attivi** e **resta in gestione** fino a
coppia chiusa o mollata, mentre ne entra uno nuovo al pavimento premiante (`inGestione`, `inGestioneDal`;
giornale `entratiInGestione`, `liberati`). **⚠ L'ESPOSIZIONE TOTALE NON È LIMITATA DAL NUMERO DI SLOT**: a
limitarla sono il **tetto per mercato** ($61,25), il cap cumulativo (**$2.400**) e il **kill a −$100**.
**⚠ UN MERCATO IN GESTIONE DEVE RESTARE ABILITATO AL RIPREZZO** (`restringiAllaSelezione` usa `idsAttivi`
per il **piano**, ma la lista del riprezzo tiene **tutti** gli id): toglierlo farebbe morire la gamba
sorella per GTD in ≤ 23 min, **prima** dei 30 della scala. **⚠ USCIRE DALLA LISTA SPEGNE L'INGRESSO, NON
L'USCITA** (verificato per assenza). **⚠ FAIL-CLOSED NEI DUE VERSI**: board o posizioni illeggibili ⇒
**nessuno esce**; una **singola** scadenza non determinabile **esclude quel mercato**. **⚠ NON ACCENDE
NIENTE**: servono ancora, indipendentemente, l'interruttore del riprezzo, AVVIA, il KILL spento e
`MANUAL_ORDER_PLACEMENT` (§4.14). **⚠ Ordina e spodesta col NETTO del knapsack**, **isteresi
`max($0,50/g, 25%)`**, e non spodesta chi ha ordini vivi o una gamba in attesa — salvo netto occupante
negativo e sfidante positivo. **⚠ UNO SCAGLIONE VUOTO NON SI RIEMPIE COL VICINO**.

**⚖️ LA DEROGA DI SECCHIO, con quattro condizioni** (23/08): ① occupante a netto **negativo**, ② sfidante
**positivo**, ③ secchio dell'occupante **sopra** la sua quota, ④ quello dello sfidante **sotto** — ③+④ sono
la ragione per cui non viola §4.13, perché lo scambio muove la composizione **verso** la cifra decisa
dall'operatore. **⚠ NON CAMBIA IL CAPITALE** ($61,25 in entrambi i secchi ⇒ `N × 2 × tetto` non contiene la
quota: è perché il secchio non governa la size che attraversarlo è ammissibile). **⚠ Fail-closed** su
netto, quota e conteggio. **⚠ SELEZIONE E PIANO GIUDICANO CON LO STESSO NETTO**: `conDistanzaDiPiano` (un
punto solo, per **entrambi** i piani) passa `offsetTicks: null` + `offsetCents`, cioè **3,0¢ su ogni
griglia**. **⚠⚠ NON MUOVE I NETTI**: governa il **costo** di selezione avversa, non il punteggio del venue
— **il lordo nasce da `levels[]` del board, che agent24 calcola con la propria posa tipica, e QUELLA resta
disallineata.**

**🔁 LA COPERTURA CONTINUA RIMETTE LA GAMBA A LIBRO** (`ripristino-gambe.js`, puro): scala sui fallimenti
**consecutivi** — subito · 5 · 10 · 20 · **30 min di tetto**, azzerata su `coperto` **osservato**, non su un
invio accettato. **⚠ IL NUMERO CHE GOVERNA IL DISEGNO È 720** (il ciclo gira ogni **120 s**; contenimento
provato: **50 tentativi su 720, 14,4×**, asserzione del test). Primo tentativo immediato perché la GTD è
23 min; il tetto sta **sopra** la GTD perché oltre quella soglia il problema è «questo mercato non si riesce
a quotare» ⇒ `da-sostituire`. **LE TRE COSE CHE NON FA**: ① non è una seconda strada verso il venue (riga
dal piano **già salvato** → `gambeDiUnaRiga` → `piazzaCoppia`, stesso freno e stessi gate); ② **non
ricostruisce il piano**; ③ **non abilita niente**. **E UNA CHE FA**: scrive **sempre** a verbale, anche
quando non tenta. **⚠ SI PIAZZA UNA GAMBA SOLA DI PROPOSITO**: l'altra **è già a libro**. **⚠ Trappola**:
`gambeDiUnaRiga` produce righe con `book` e **senza `tokenId`** mentre `valutaCopertura` risponde in
**token**, e `LOCK.stato()` restituisce **`id`**, non `conditionId`.

**⚖ IL RIPRISTINO RICOSTRUISCE LA COPPIA, NON LA GAMBA** (`coppia-simmetrica.js`, puro, zero `require`):
**una size per entrambe**, `Q = min(Q_piano, Q_tetto, Q_gamba_viva)`, e nessuno dei tre può far CRESCERE
niente. **⚠ `Q_gamba_viva` LA RENDE MONOTONA. ⚠ `Q_tetto` usa i prezzi VERI di ciò che resterà a libro**,
col tetto `MARKET_CAP_FIXED_USD` e non `capPerMarketUsd` (qui non si pianifica: si dimostra che il gate non
rifiuterà). **⚠ SOTTO IL MINIMO PREMIANTE NON SI RICOSTRUISCE, e il tetto NON si allarga. ⚠ PRIMA SI
RIDUCE, POI SI PIAZZA**; se la riduzione fallisce **non si piazza**, il lucchetto copre entrambe e **il
prezzo della gamba viva non si tocca**. **⚠ LE DUE LETTURE DEVONO CONCORDARE**: lati diversi fra
`v.mancanti` e gli ordini vivi ⇒ **nessuna azione**; gli ordini vivi si **passano**, non si rileggono.

**Il terzo meccanismo che può spegnere un mercato.** Gli altri due sono `setTracking` (ciclo 6 h) e
`impostaBot` (fermo di sicurezza). `trigger-capitale-fermo.test.js` pretende che **ogni `enabled: false`
del file appartenga a un meccanismo dichiarato**; il pattern **non** è stato allargato a un
`setAutoReprice(` generico — sarebbe un varco largo quanto il file.

**Due trappole di questo codice:** `\brain\b` senza ancore classifica come meteo **«Ukraine signs peace
deal with Russia before 2027?»**. E `Number(riga.rewardsMinSize)` su un campo assente vale **0**, cioè
`0 ≤ 20`: un mercato di cui non si sa il pavimento premiante veniva dichiarato **il più finanziabile di
tutti** (§5.3).

### 4.14 · Le QUATTRO cinture, e mordono tutte e quattro

**LE CINTURE DELL'OPERATORE SONO QUATTRO E MORDONO TUTTE**, sulla strada da cui il bot piazza davvero
(§5-bis p.191). La quinta, `MAKER_PLACEMENT`, è stata **tolta** e non disarmata: era un ripiego
sull'ambiente **senza chiamanti** — *«una cintura senza chiamanti è peggio di nessuna, perché me la fa
contare»*. ⚠ Toglierla **STRINGE**: senza ripiego, un chiamante che non passa `placement` ottiene
`dry-run`, la posizione chiusa.

| cintura | dove morde | gate |
|---|---|---|
| `MAKER_MODE` | `evaluatePlacementGate`, via `buildPlacementAdapter` | `maker-mode` |
| `MAKER_ADAPTER_DRYRUN` | idem | `dry-run` |
| `MANUAL_ORDER_PLACEMENT` | l'ultimo `if` prima della POST (`adapter.js:923`) | nessuno: `dry-run-validated` |
| freno di agent41 | `giro()` e `controlloCapitaleFermo` ⇒ `dryRunOnly` alla corsia in blocco | nessuno: non si invia |

**⚠ Le prime due vengono da `lib/maker/cinture-armamento`**, cioè dallo **stesso modulo da cui `stato.js`
le racconta**: non uno specchio da confrontare ma **la** lettura — il reperto D1 qui non è esprimibile.
**⚠ MONOTONO PER COSTRUZIONE** (modo non vivo ⇒ `off`, ombra ⇒ rifiuto; ambiente illeggibile ⇒ entrambe
scattano). **⚠ NON TOCCA LETTURE NÉ CANCELLAZIONI**: `buildPlacementAdapter` ha **un solo chiamante**, e
leggere e cancellare passano dall'adapter cancel-only — il guardiano cancella. **⚠ `puoPiazzare` resta «le
quattro sono aperte», non «l'ordine passerebbe»**: davanti restano `kill`, `venue-allowlist`, `limit-*`,
`v2-sdk-*`, `funding-approval`. **LA PROVA**: `node scripts/ricerca/prova-cinture.js` — **10 verdi, 0
rossi**, ognuna inserita **da sola** più il **CONTROLLO**. ⚠ Un banco che cabla modo/`dryRun`/`placement`
ignorando gli `opts` è **più permissivo del venue proprio sulle cinture**: il seam dev'essere solo la rete.

## 5 · QUESTIONI APERTE

Solo voci con evidenza reale nel codice, nei commit o nei file di stato. Chiuso ⇒ si toglie di qui e
resta una riga nel registro di §5-bis.

### 5.1 · Riavvii e ambiente dei processi — le tre regole che valgono

**LA FLOTTA È ACCESA: 11 processi** (§5-bis p.188-191). `pm2 start agents/ecosystem.config.js`
dall'utente `bot` + `pm2 save`; un solo `cwd` (`/home/bot/bot`), e `cwd`/`HOME` **non sono più
letterali** (`__dirname/..` e `os.homedir()`), quindi il config non può puntare a un repo diverso da
quello da cui è stato letto. **⚠ Nessuna riga di questo file va creduta su uno stato che un comando può
leggere**: `scripts/cli/stato.js` legge `pm2 jlist` e confronta i due elenchi **nei due versi**
(definiti-ma-assenti, vivi-ma-non-definiti), e le cinture da `/proc/<pid>/environ`.

**⚠ `pm2 startup` NON È STATO FATTO** (richiede root): al suo posto una riga `@reboot` nella crontab di
`bot` che chiama `pm2 resurrect`. Il modo giusto resta
`sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u bot --hp /home/bot`,
e **fatto quello la riga di cron va tolta** — due meccanismi che riaccendono la stessa flotta sono
peggio di uno. ⚠ `pm2 resurrect` rilegge il **dump**, non l'ecosystem: dopo ogni cambio alla flotta va
rifatto `pm2 save`, o il riavvio riporterebbe su la flotta di ieri.

**⚠ I PROCESSI CHE DECIDONO UN PREZZO SI RIAVVIANO INSIEME, O I PREZZI DIVERGONO.**
`MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V` è un **env**, quindi vive nel processo: se agent41 riparte e
agent40 no, agent41 apre a una distanza e il rinnovo di agent40 riporta l'ordine a un'altra — non è
pericoloso (la manopola può solo allontanare dal mid), ma rende **illeggibili** i dati. Lo strumento che
le tiene allineate è `node scripts/cli/distanza.js`.
**⚠ E DAL 24/08 ANCHE `MAKER_MERCATI_CONTEMPORANEI` STA SU ENTRAMBI**, dallo stesso `const`: agent41 la usa per
scegliere, ad agent40 serve per verificare all'avvio la stessa invariante. Un riavvio scoordinato non può farli
divergere (il letterale è uno), ma **togliere la variabile a uno dei due lo tiene giù**.
**⚠ E `pm2 restart <nome> --update-env` NON RILEGGE `ecosystem.config.js`**: `--update-env` prende
l'ambiente della **shell**. Per una variabile NUOVA serve il riavvio **dal file**:
`pm2 restart agents/ecosystem.config.js --only <nome>`. Vale per `MAKER_MERCATI_CONTEMPORANEI` (R1).

**⚠ LE MODIFICHE A `lib/rewards/allocator.js` ENTRANO IN SERVIZIO SENZA RIAVVIO**: il piano nasce in un
processo figlio che rilegge il file da disco a ogni giro (§5.3). Quello che vive nel processo di agent41
sono le righe di log e il cablaggio.

**⚠ Le tre variabili del banco** (`MAKER_FEED_BOOKS_FILE`, `MAKER_FEED_BOARD_FILE`, `POLY_CLOB_BASE`)
non sono dichiarate né nell'ecosystem né nel `.env`: i processi vivi leggono la directory di servizio di
§5.3, non i file del banco.

### 5.2 · Aperte

> **Voci di §5.2 CHIUSE** (p.15/16, p.17, p.18, p.21, p.28, p.37, p.39, p.49, p.54, p.57):
> diagnosi integrale in **`docs/registro-voci-chiuse.md`**, regole vive nelle sezioni citate.

49. **✅ CHIUSA IL 21 AGOSTO** — catena obiettivo/stima concorde al bit. Diagnosi:
   `docs/registro-voci-chiuse.md`.
55. **🔴 IL TETTO DEL BOARD E' IL PRIMO DI TRE CANCELLI, E DA SOLO NON APRE NIENTE — 21 agosto.**
   Allargare la vista (150 → 300) rende i mercati **visibili alla selezione**, ma perche' uno entri
   davvero servono altri due passaggi che **non sono stati toccati**: ① il piano scarta chi ha
   `profondita: 'non-verificata'` (`allocator.js:1133`), e la verifica vuole **campioni websocket**, che
   esistono solo per i mercati che agent34 sottoscrive — **95 mercati / 190 asset** all'ultima lettura,
   con la corsia dichiarata a **60** in §4.7; ② il **netto** che ordina e spodesta nasce da quel piano,
   quindi un mercato senza copertura ws non ha netto e `ordinaCandidati` lo mette **dopo** tutti quelli
   che ce l'hanno. Misurato adesso in produzione: `valutati 114 · ammissibili 29 · nettiIniettati 29`;
   con 294 ammissibili la corsia ws non puo' coprirli tutti. ⚠ **E il vertice della vista larga e' fatto
   proprio di quei mercati**: 13 dei 20 migliori per premio atteso hanno concorrenza ZERO, cioe' il caso
   che il cancello ① esiste per rifiutare. **NON CORRETTO**: la leva e' la corsia del feed (e il suo
   tetto), non il tetto del board, ed e' una decisione dell'operatore — alzare la corsia significa piu'
   sottoscrizioni ws e piu' `mid-history` su disco (§5.2 p.43: ~285 MB/g su 90 mercati).
54. **✅ CHIUSA IL 22 AGOSTO** — `Δcassa + Δsize ≈ 0`, o il totale non è misurabile. Regola viva
   in §3; diagnosi: `docs/registro-voci-chiuse.md`.
69. **🔴 L'INTERRUTTORE DEL FILTRO METEO NON ESISTE: `MAKER_FILTRO_METEO` NON È IN NESSUN SORGENTE —
   23 agosto 2026, 15:35Z, NON corretto.** §4.13 ha dichiarato per mezza giornata un interruttore
   (`filtroMeteoArmato`, «assente ⇒ armato, solo `'0'` disarma») che **non è mai stato scritto**:
   zero occorrenze di `filtroMeteoArmato` in `lib/`, `agents/`, `scripts/` — l'unica in tutto il repo
   era la riga di `CLAUDE.md` che lo descriveva, cioè **il documento citava se stesso come prova**.
   `MAKER_FILTRO_METEO` non compare in nessun `.js`, né in `agents/ecosystem.config.js`, né in `.env`,
   né in `/proc/<pid>/environ` di agent41. Il cancello vero è nudo a `selezione-mercati.js:469`:
   `if (eMeteo(riga)) return { ammissibile:false, motivo:'famiglia-meteo' }`. **⚠ IL MODO PEGGIORE IN
   CUI UNA MANOPOLA PUÒ FALLIRE**: mettere `MAKER_FILTRO_METEO: '0'` nell'ecosystem e riavviare
   **dal file** non cambierebbe nulla, e chi lo facesse crederebbe di aver disarmato. **IL COSTO,
   MISURATO** (`data/ricerca/slot-corto-vuoto-1540.json`, classificatore `eMeteo` del modulo): dei **75**
   mercati del board fra 24 e 48 h, **72 sono meteo**; dei 3 superstiti due hanno `minSize 50`, quindi
   per il posto «basso» libero resta **un candidato solo** — ed è la causa dello slot corto vuoto di
   §5.2 p.72. **Non corretto**: scrivere l'interruttore è un lavoro su un cancello di selezione, e la
   decisione se il meteo debba entrare è dell'operatore (v. §5.2 p.58, il payback li giudicherebbe
   comunque uno per uno). Classe **D7**, nella variante peggiore: il commento non descriveva una riga
   sbagliata, descriveva una riga **inesistente**.
   **⚠ AGGIORNAMENTO 24 AGOSTO 2026 — LA FALSA RICETTA DI RIPRISTINO È STATA TOLTA, IL FILTRO NO.**
   `APERTI.md` conteneva un `sed -i "s/MAKER_FILTRO_METEO: '0'/…'1'/" agents/ecosystem.config.js`: quella
   stringa non esiste, il `sed` non sostituiva nulla, **usciva 0** e la riga proseguiva col `&&` fino a
   `pm2 restart` — cioè **dichiarava un riarmo mai avvenuto e riavviava per niente**. Era p.69 spostata dal
   documento allo strumento di rollback, il posto peggiore: un ripristino che fallisce in silenzio si scopre
   quando serve. Sostituita con la verità in tre righe. **⚠ IL FILTRO RESTA ARMATO E NON SPEGNIBILE** —
   l'interruttore non è stato scritto — e **questa voce resta APERTA**. ⚠ Stessa classe, trovata di riflesso e
   corretta: la riga di ripristino del cap conteneva un `sed` su `const MAX_MERCATI_CONTEMPORANEI = 19;`,
   letterale che dal 24/08 non esiste più.
70. **🔴 UNA RIGA DI PIANO SENZA ABILITAZIONE AL RIPREZZO: `live-min-market-mismatch` MURA UNO SLOT —
   23 agosto 2026, NON corretto.** `0x5e082f0b57` (1 Fed rate cut 2026) è **selezionato**, ha una riga
   di piano, e `ripristino-gambe` l'ha tentato **8 volte in 2 ore**: tutte rifiutate con
   `gate: live-min-market-mismatch`, cioè il mercato non è nell'allowlist del riprezzo. Il piano lo
   finanzia, il perimetro non lo ammette, **$61,25 di slot fermi** e nessun ordine mai piazzato; dopo
   24,6 min lo slot è stato rilasciato come sterile «NESSUN subentrante». È un'inversione d'ordine fra
   `preparaMercatoNuovo` (che abilita) e il tentativo di piazzamento. ⚠ **La regola dello slot sterile
   nasconde il sintomo**: rilascia lo slot e azzera il contatore, quindi il caso si ripresenta al giro
   dopo invece di accumularsi in un contatore visibile. **Non corretto**: tocca l'ordine di due azioni
   su capitale reale. Misura in `data/ricerca/riconciliazione-fermo-1535.json`.
71. **🔴 IL FIGLIO DEL PIANO NON CI STA IN MEMORIA, E QUANDO MUORE LA ROTAZIONE PERDE IL NETTO —
   23 agosto 2026, NON corretto.** La macchina ha **1.855 MB** totali, ~**400 MB** disponibili e 1,5 GB
   di swap già usato; il figlio del piano ne chiede ~1 GB. Conseguenza **in produzione**, non teorica:
   `netti dei candidati non calcolabili (timeout 120000ms) — la selezione ordina col lordo e non
   spodesta nessuno` compare **18 volte** nella coda del log di agent41, più `nessuna riga nel piano
   salvato, e il piano fresco non e' disponibile` su tre mercati. ⚠ **È il meccanismo che avrebbe tolto
   gli occupanti a netto negativo a spegnersi**: il 23/08 alle 15:35Z due slot erano tenuti da mercati a
   **−$0,25/g** e **−$9,98/g** (§5.2 p.70 e la deroga di secchio di §4.13 esistono proprio per quello),
   e nessuno li ha spodestati perché il netto non era calcolabile. ⚠ **E rende non riproducibile la
   diagnosi**: un replay del piano da una sessione di ricerca muore con **SIGABRT (OOM) 3 volte su 3**,
   quindi le cause per mercato oggi si leggono **solo** dal giornale di agent41. **Non corretto**: la
   leva è memoria o un piano che non tenga in RAM il registro dei candidati, ed è una decisione.
72. **🟡 LO SLOT CORTO/BASSO È VUOTO E IL REFERTO NON SA DIRE PERCHÉ — 23 agosto 2026, NON corretto.**
   Alle 15:22Z: `postiNonAssegnati [{scaglione:'basso', posti:1}]` + `fasce.postiVuoti [{fascia:'corta',
   posti:1}]`, `slotVuotiPerScarsita.motivo` rimanda «alla composizione o agli scarti dichiarati qui
   accanto» — ma i 3 `scartatiPerComposizione` sono **tutti «alto»**, quindi per quel posto la frase
   **non è vera**. L'unico candidato idoneo (`0x0be89faf83`, MrBeast 39-41M, minSize 20, 32,4 h) **non
   compare in nessuna lista**: non è in quarantena, non è fra gli scarti, non è fra gli ammissibili.
   Cade prima del cancello di composizione, esattamente come §5.2 p.62. La cura è una lista
   `scartatiPerAmmissibilita` col motivo di `valutaAmmissibilita`; **non fatta**: cambia la forma del
   referto, che altri lettori confrontano.
65. **🔴 LA QUOTA CODA LUNGA IN SERVIZIO È 0,50, MA CHIUNQUE LA LEGGA FUORI DA agent41 VEDE 0,12 —
   23 agosto 2026, NON corretto.** `MAKER_QUOTA_CODA_LUNGA: '0.5'` sta **solo** in
   `agents/ecosystem.config.js:690` — non nel `.env` — e `horizon.LONG_TAIL_CAP_FRAC` si calcola
   **una volta sola al caricamento del modulo** (`horizon.js:213`). Il figlio del piano la vede
   perché `execFile` è chiamato **senza opzione `env`** e quindi eredita l'ambiente di agent41
   (`agent41-realloc-scheduler.js:698`). **Ma qualunque strumento lanciato da una shell** — uno
   script di ricerca, `node -e`, un test — carica `horizon.js` **senza quella variabile** e ottiene
   il difetto **0,12**, cioè un quarto del valore vero. **⚠ NON È TEORICO: ha già prodotto un
   referto sbagliato.** Il referto delle 11:42Z del 23/08 dichiarava «6 mercati respinti da
   `quota-coda-lunga`, $367,50 fermi»; rimisurato con l'ambiente vero (letto da
   `/proc/<pid>/environ`) i respinti sono **5 su 27 ammissibili** e il netto che bloccano è
   **$0,0277/giorno**, non una frazione del piano. È la classe «due strade che rispondono alla
   stessa domanda con numeri diversi», nella variante peggiore: la strada che **sbaglia** è quella
   che si usa per **misurare**. **⚠ E `scripts/cli/stato.js` non stampa affatto questa quota**,
   quindi oggi il valore in servizio non è leggibile da nessun comando. La cura è che chi misura
   legga l'ambiente del processo vivo (come fanno le cinture e R1), non `process.env` della propria
   shell; **non fatta**: tocca il modo in cui si misura, e la misura è la cosa da non sporcare
   mentre la si sta usando per decidere.
66. **🔴 `scripts/dipendenze-scollegate.js` NON VEDE IL FILO TAGLIATO FRA DUE MODULI — 23 agosto
   2026, NON corretto.** Cerca le `deps.*` facoltative che nessuno inietta; il difetto del 23/08 era
   un **argomento nominato** (`rinnovo`) costruito dal chiamante, passato dentro l'oggetto e **mai
   destrutturato dal chiamato**. Lo strumento ha risposto «0 facoltative mai iniettate in moduli
   VIVI» mentre l'esenzione era morta da **sette giorni** e costava 39 ordini in un turno. La cura è
   un rilevatore che confronti le chiavi passate a un chiamato con quelle che il chiamato
   destruttura. **Non fatta**: è un secondo lavoro e tocca lo strumento con cui si misura.
67. **🟡 IL `gate` ORIGINALE DEL RINNOVO SI PERDE NELL'AUDIT — 23 agosto, NON corretto.**
   `auto-reprice.js:1751` sovrascrive `d.gate` con `motore-non-conforme`, quindi la riga non dice
   più se il rinnovo veniva da `expiry-refresh` o da un inseguimento: per contare i 49 è stato
   necessario dedurlo dal testo del `reason`. Stessa famiglia di p.59. **Non corretto**: cambia la
   forma del giornale, che altri lettori confrontano.
68. **🟡 `provaRinnovo` CONDIZIONE ③ È SBAGLIATA DI VERSO SU UNA GAMBA SELL — 23 agosto, NON
   corretto.** «Il nozionale non aumenta» è il conto di chi **compra**: su una SELL un prezzo più
   alto è **meno** probabile che venga riempito, cioè meno rischio, non più. Oggi il modulo lo tratta
   come apertura e **nega** l'esenzione — sbaglia nella direzione **prudente**, ed è per questo che
   non è stato toccato. **Serve una decisione dell'operatore**, non una patch.
61. **🟡 `selezione-cablata.test.js` CONTA I SELEZIONATI INVECE DEGLI ATTIVI — 22 agosto, NON corretto.**
   L'asserzione «e il vincolo e' esattamente l'insieme scelto» (riga 95-96) confronta
   `onlyMarketIds.length` con **tutti** i selezionati, mentre `restringiAllaSelezione` usa
   `idsAttivi`, cioe' i **non-in-gestione** — che e' il comportamento corretto e documentato in §4.13
   («usa `idsAttivi` per il piano, ma la lista del riprezzo tiene tutti gli id»). ⚠ **Il codice ha
   ragione, il test no**: e' verde solo finche' nessun mercato e' in gestione, e diventa rosso al
   primo fill. Misurato: 13 selezionati, 12 attivi, 1 in gestione (MrBeast con la posizione aperta).
   La cura e' una riga (`scelti` → i soli `inGestione !== true`). **Non corretto**: e' un secondo
   lavoro, e il prompt chiedeva il tick.
60. **🟡 `marketMeta` ESPLODE SU UN ELEMENTO NULLO IN `rows` — 22 agosto, preesistente, NON corretto.**
   `allocator.js:111` fa `r.bidDepthInBand` senza guardia, quindi un `null` nell'array dei campioni
   solleva `TypeError` prima di qualunque altra cosa. Trovato scrivendo il test del tick, non da un
   caso vero: **non e' noto se in produzione `rows` possa contenere elementi nulli**, e senza quella
   prova non si corregge (una guardia aggiunta a caso sposta il comportamento in un verso che nessuno
   ha misurato). Dichiarato perche' chi tocchera' quella funzione lo sappia.
59. **🟡 IL GIORNALE REGISTRA `gamba-impossibile` SENZA IL SOTTO-MOTIVO — 22 agosto, NON corretto.**
   `data/realloc-scheduler.jsonl` porta `motivo: "gambe non costruibili: gamba-impossibile"` e basta;
   il dettaglio vero («offset non valido», cioe' il tick mancante) vive solo nel valore di ritorno di
   `gambeDiUnaRiga` e **non arriva a disco**. Conseguenza misurata: la diagnosi del difetto del tick
   non era raggiungibile dal giornale — e' servito ricalcolare le gambe fuori processo. Un motivo che
   non si scrive e' un motivo che non esiste il giorno dopo.
58. **🔴 IL PAYBACK RIFIUTA I CORTI CHE LA SELEZIONE AMMETTE — 22 agosto 2026, NON corretto.**
   La fascia corta adesso vede, sceglie e prezza (§4.13), ma il piano non la finanzia: su
   `0x9db884ee` (MrBeast, 31 h) `horizonVerdict` risponde **`short`** — «scade fra 1,3 g ma il
   rientro ne chiede 1,7» (`horizon.js:294`, `days <= payback`). Non è un cancello di
   configurazione: è **economico**, dice che il costo di adverse selection modellato non rientra
   prima della risoluzione. ⚠ **La stima di premio che ha giustificato la fascia NON passava di
   qui**: `realisticEstimate` applica banda e quota, non il payback, quindi i $30,55/g della
   simulazione a secco sono un **limite superiore** e il numero che il piano userà è più basso.
   **Non corretto di proposito**: aggirare il payback è allentare un limite di rischio, e la
   domanda vera — se su un mercato a 30 h il costo di adverse selection sia stimato bene — è una
   misura che non esiste. **Serve una decisione dell'operatore**, non una patch.
57. **✅ CHIUSA IL 22 AGOSTO, sera** — `quotaScaglioni` dà `round(N/3)` posti «basso» (almeno 1, al
   più N−1). ⚠ **Non muove il capitale**: `MARKET_CAP_FIXED_USD` è $61,25 in entrambi i secchi, e la
   quota non compare in `N × 2 × tetto` (asserito, `secchio-basso-scala.test.js` ⑤). Regola viva in
   §4.13; diagnosi: `docs/registro-voci-chiuse.md`.
64. **✅ SUPERATA IL 23/08 dalla p.31-bis** — i corti sono a `MAKER_DISTANZA_CORTI_CENTS='3.5'`
   (`ecosystem.config.js:676`, confermato in `/proc` di agent41). ⚠ Resta viva **la regola
   dell'operatore**: almeno **un tick di margine dal bordo**, e se non ci sta si ferma a «il valore
   chiesto meno un tick». La misura che portò a 3,0¢ (121 corti, tick 1,0¢, banda ±4,5¢, premio
   $2,5923/g a 3,0¢ · $1,2282/g a 3,5¢ · $0,3216/g a 4,0¢) è in `docs/misure-e-tarature.md`.
62. **🟡 I MERCATI IN QUARANTENA SLOT-STERILE NON COMPAIONO IN NESSUNA LISTA DI SCARTO — 22 agosto,
   NON corretto.** Entrano in `escludi` (`agent41-realloc-scheduler.js:2479`, unione con la quarantena
   del venue) e cadono a `selezione-mercati.js:787`, cioè **prima** del cancello di composizione:
   quindi non finiscono né in `scartatiPerComposizione` né in `scartatiPerFascia`. Conseguenza
   misurata il 22/08 alle 22:58Z: dei 4 slot vuoti, i 2 «alto» erano vuoti **per la quarantena** e il
   referto diceva `slotVuotiPerScarsita.motivo: «la ragione è nella composizione o negli scarti
   dichiarati qui accanto»` — che per quei due posti **non è vero**. La cura è una lista
   `scartatiPerQuarantena` col motivo e la scadenza; **non fatta**: cambia la forma del referto, che
   altri lettori confrontano.
63. **🟡 IL CAMPIONATORE DELLA STIMA TACE SU DUE STATI DIVERSI — 22 agosto, NON corretto.**
   `agents/agent40-manual-reprice.js:2441-2466` (`campionaStima`) ha un `catch { }` **muto**: un'eccezione
   di `buildMarketBoard`/`buildOrderBoard` e un `estGrossUsdPerDay === null` producono dall'esterno lo
   **stesso** effetto — nessuna riga in `data/stima-campioni.json` e nessuna riga di log. Misurato: il
   file è fermo a **20:50:42Z**, 11 s dopo il riavvio di agent40, e alle 23:00 la copertura della
   giornata è **0,8753** con due ore intere senza un campione. `registraCampione` restituisce
   `{scritto:false, motivo}` e **nessuno lo legge**. La cura è un log del motivo e un `catch (e)` che
   distingua; **non fatta**: tocca il percorso che misura, e la misura è la cosa da non sporcare
   mentre la si diagnostica.
56. **🟡 UN MERCATO CHE ATTRAVERSA LE 48 h NON RICEVE LA DISTANZA DELLA FASCIA NUOVA — 22 agosto.**
   La fascia si valuta **fresca a ogni giro** (giusto: è funzione dell'orologio, §5.2 p.51), ma
   `targetOffsetCents` si scrive **una volta sola, all'ingresso**. Misurato: `0x4757745c` è entrato
   a 48,4 h come «lunga» e adesso è «corta» a 47,8 h, conteggiato fra i 5 corti ma quotato a
   2,05¢. ⚠ **Non corretto, ed è la scelta prudente**: scrivere l'offset a fascia cambiata farebbe
   scattare l'inseguimento di agent40 su un ordine VIVO, cioè un cancella-e-ripiazza che perde la
   priorità di coda su un mercato che sta lavorando bene — esattamente ciò che §11 vieta. Il caso
   si consuma da sé (un corto scade entro 48 h). Va saputo leggendo il referto: «5 corti» non vuol
   dire «5 a 3,0¢».
55-bis. **🟡 LA CORSIA CALDA È PIENA E I CANDIDATI PRENDONO ZERO — 22 agosto, mitigato NON risolto.**
   Con 60 posti occupati da righe del piano + selezionati + **trattenuti**, la classe `candidati`
   riceveva **0**: l'unica porta d'ingresso per un mercato nuovo era chiusa. Mitigato con una
   classe `prioritari` (≤ 12, la sola che scavalca i trattenuti). ⚠ **La leva vera resta il tetto
   della corsia (60)**, e alzarlo è una decisione dell'operatore: più sottoscrizioni ws e più
   `mid-history` su disco (~285 MB/g su 90 mercati, §5.2 p.43).
53. **🟡 IL CICLO NON DISTINGUE «FIGLIO MORTO» DA «NIENTE DA FARE» NELL'ESITO — 21 agosto 2026.**
   `lib/maker/realloc-cycle.js:255-261`: se il piano fallisce e `triggerValidita` e' FALSO si esce con
   `mancato(...)` ⇒ **`referto('nessuna')`**, lo stesso esito di «non c'era niente da fare». Nel record
   la differenza c'e' (`valore.misurabile === false`, traccia `piano/fallito`) ma **nessuna difesa
   reagisce**. ⚠ E il ramo contiene un **fail-open**: il commento dice «non stava per succedere
   niente», ma dopo `mancato()` il ciclo ritorna e `confrontoDiValore` — il SECONDO trigger — non gira
   mai, quindi «non stava per succedere niente» e' proprio cio' che il figlio morto ha impedito di
   sapere. Un trigger **non misurato** trattato come **non scattato**: la famiglia `Number(null) === 0`
   di §5.3 in forma di flusso di controllo. **Non corretto**: cambiare la tassonomia degli esiti del
   ciclo e' un secondo lavoro, e chiuso l'OOM il caso diventa raro.
51. **🟡 LO `scaglione` SALVATO NELLO STATO PUO' DIVERGERE DA QUELLO CALCOLATO — 21 agosto 2026.**
   `selezione-mercati` rifiuta lo scambio quando `v.scaglione !== occ.voce.scaglione`: il primo e'
   **ricalcolato** dal `rewardsMinSize` corrente, il secondo e' **congelato** in
   `data/selezione-mercati.json` all'ingresso. Se il venue cambia `rewardsMinSize`, o se cambia
   `MAKER_MERCATI_CONTEMPORANEI` (a N=1 i secchi diventano UNO e si chiama `alto`), un occupante resta
   con un secchio che non esiste piu' e **diventa non spodestabile in silenzio**. Trovato dal test di
   p.200 che falliva, non dalla rilettura. **Non corretto**: cambia il comportamento della rotazione.
52. **🟡 `lib/maker/quantita-davanti.js` NON HA CHIAMANTI — 19 agosto 2026, non tracciato da git.**
   E' la forma che §4.14 chiama «una cintura senza chiamanti e' peggio di nessuna, perche' me la fa
   contare». **Non toccato.**
50. **🟡 `1 − 2d` HA ANCORA UNA TERZA COPIA, NELLA CORSIA DEL BACKTEST — 21 agosto 2026.**
   `scripts/rewards-replay/lib/allocate.js:387` (`pairCostForMarket`) riscrive `1 − 2d` invece di
   importare `size-da-capitale.costoCoppiaAllaDistanza`. Oggi i due numeri **coincidono** (verificato:
   stessa guardia `d >= 0.5`, stesso arrotondamento a 9 cifre), quindi non c'e' divergenza da misurare —
   ma sono due copie, cioe' il reperto D1 in attesa. **Non corretta di proposito**: quel file e' la
   corsia del backtest e ogni driver storico ci passa; toccarlo puo' muovere serie storiche che esistono
   per essere confrontate, e la decisione e' dell'operatore, non della patch.

48. **🟡 `flatUserShare` (KALSHI) HA LO STESSO DENOMINATORE E NON E' STATA TOCCATA — 21 agosto 2026.**
   `lib/rewardScore.js` `flatUserShare` divide ancora per il mid. Kalshi **non pubblica ne' banda ne'
   formula**: quella funzione rispecchia il modello OSSERVATO di agent25, e cambiarne il denominatore
   senza una formula del venue a cui ancorarsi sarebbe speculativo. Il confine e' **fissato da
   un'asserzione** (blocco ⑧ di `rewardScore-denominatore.test.js`), cosi' l'omissione resta una scelta
   leggibile e non una svista.
47. **🟡 `reward-layered.js:188` PASSA UN BUDGET PER LATO A UNO SCORER CHE ORA VUOLE IL TOTALE — 21/08.**
   `perSideSizeUsd` e' per lato **e** ogni gamba viene dimensionata al proprio prezzo
   (`sizeUsd/bidPrice`, `sizeUsd/askPrice`), quindi quel modello produce **share DIVERSE sui due lati**:
   `quadraticUserShare`, che assume la posa simmetrica, non e' mai stato lo scorer giusto per lui —
   disallineamento **preesistente**, non introdotto qui. Nessun chiamante di produzione
   (`perSideSizeUsd` compare solo nel `.d.ts`), e il `dashboard` non e' nella flotta. Non corretto: la
   scelta fra «passare il totale» e «cambiare modello» ha bisogno di una decisione, non di una patch.
46. **🟡 `reward-gating.ts:59` LEGGE UN CAMPO CHE NESSUNO SCRIVE — 21 agosto 2026.**
   `!!m.levels[capitalKey]?.aboveMin`, ma `agent24.computeLevels:553` **non copia mai `aboveMin` dentro
   `levels[C]`** (lo calcola `estimateCapitalLevelRange` e lo lascia al livello superiore). Il gate vale
   quindi **sempre `false`**. Difetto preesistente, indipendente da D1; superficie del pannello.
45. **🟡 IL RILEVATORE «STATO TOCCATO» DELLA SUITE NON DISTINGUE CHI HA SCRITTO — 21 agosto 2026.**
   `suite-rossi.js` ha segnalato `data/selezione-mercati.json` come toccato, ma quel file lo riscrive
   **agent41 ogni 120 s** per mestiere: il rilevatore guarda l'mtime e non l'autore, quindi su flotta
   accesa e' **sempre** positivo e non puo' piu' segnalare il caso vero (un test che scrive nello stato
   di produzione, §5 punto 1). Verificato che lo stato e' sano: `by: agent41 · selezione automatica`.

44. **🟡 LA META' DI R6 CHE MORDEREBBE DAVVERO NON E' IMPLEMENTATA — 18 agosto 2026.** «Anche oltre
   101¢» vale per **comprare l'altro lato** e sbloccare un residuo col merge. Non esiste un percorso che
   compri sopra il tetto della coppia, e inventarlo sarebbe un meccanismo nuovo su capitale reale. La
   metà implementata — vendere attraversando, anche sotto il minimo — copre il caso comune. **Serve una
   decisione**: quanto sopra 101¢ si può spendere, e con quale tetto in dollari.
43. **🟡 R4: SUL LATO MISURABILE NESSUN CROLLO, SUL LATO CHE SI È RIEMPITO NON SI SA — 19 agosto.**
   Replay sui book del 18 (`data/ricerca/erosione-18-agosto.md`, modulo VERO): sulle **vite reali** dei
   47 ordini misurabili, a **40% ZERO scatti e ZERO letture singole sotto soglia**; il minimo di tutta
   la giornata è **58,9%** della baseline. La soglia non è tarata male, è lontana dai dati. **Il fill
   del 23:17:21 è venuto dal MID**: profondità davanti piatta a 260 share fino a **−2 s**, poi il mid
   salta **+8¢ in un solo intervallo**; il crollo (−72%) arriva **dopo**. Prima soglia che produce
   qualcosa: **60%, 1 scatto in tutta la giornata**; a 80% sono 3.
   **⚠ MA IL FILL ERA SULLA GAMBA NO, E `mid-history` REGISTRAVA UN SOLO BOOK PER MERCATO**: la
   conclusione «nessun crollo» è provata sul **lato sbagliato**, e per le **20 gambe NO su 67** non
   esiste una riga su disco. Cercate le altre fonti: tape (prezzi, non profondità), `auto-reprice`
   (mid NO e miglior bid altrui a 5 s, ma `depthAheadUsd` è `null` in tutta la finestra), clob-audit,
   osservatore — **nessuna ha la profondità**. Ciò che si ricava: alle 23:17:11 il nostro bid NO era a
   72¢ col **miglior bid altrui a 63¢**, cioè **davanti a noi non c'era nessuno** ⇒ lì R4 non avrebbe
   potuto scattare a nessuna soglia (`zoneDepth` su zona vuota non riscalda mai, «è voluto»). **Resta
   aperto COME siamo rimasti soli**: fra 23:02 e 23:17 nessun record, e se la coda si è assottigliata
   lì, quella era l'erosione.
   **⚠ IL DATO C'ERA E LO SCRITTORE LO BUTTAVA**: `reconcileSubscriptions` sottoscrive il token NO da
   sempre (agent34:705, `side:'no'`); era `sampleMidHistory` a guardare solo `meta.tokenId`.
   **Corretto il 19 agosto** e **in servizio dal riavvio di agent34** (verificato sulle righe vive: 244
   righe col campo `no`, 190 coi livelli su entrambi i lati): ogni riga porta `no: {…}` col book
   completo, e i campi di primo livello restano intatti per i cinque lettori esistenti
   (`lib/mid-history-due-book.test.js`, 33/33, rosso sul sorgente di ieri). **⚠ Il 18 agosto non si
   recupera.**
   **⚠ E «MIGLIOR BID ALTRUI» NON DIVENTA UNA SERIE**: `mid-history` registra il book **grezzo**, che
   include i NOSTRI ordini. Per R4 non serve — `zoneDepth` salta per costruzione il proprio livello e
   tutto ciò che sta sotto, quindi la profondità davanti è già «altrui». Restano non rispondibili
   *quanto del libro era nostro* e il caso di **due nostri ordini vivi sullo stesso lato** (durante un
   ripristino di gamba), dove il più lontano dal mid verrebbe contato come altrui — cioè l'errore cade
   nella direzione che rassicura. Chiuderlo vorrebbe dire scrivere i nostri ordini nella riga, e
   agent34 è il processo **senza credenziali**: è una scelta di superficie. Dettaglio in `APERTI.md` §7. ⚠ Costo: la riga quasi raddoppia (~148 →
   ~285 MB/g su 90 mercati, ~4 GB sui 14 giorni di ritenzione, 9,2 GB liberi). La leva è
   `MID_HISTORY_RETENTION_DAYS`, **non** l'intervallo: 75 s è già ciò che limita la misura.
   **⚠ ALTRI DUE LIMITI**: il feed campiona ogni **75,0 s** (non ~115) contro i 5-10 s di agent40,
   quindi un crollo più breve di **150 s** è invisibile e i numeri sono un **limite inferiore** ·
   **18 vite su 47 non riscaldano nemmeno la baseline**. **Nessuna soglia toccata.**
42. **🟡 `tre-fix-sicurezza.test.js` SCADE, NON FALLISCE — 17 agosto 2026.** 48-50 s contro il limite di
   60 s di `suite-rossi.js:25`: entra ed esce dai rossi col carico della macchina (49,98 → 48,42 s prima e
   dopo le modifiche del 17, quindi non è una regressione). **Un test che scade è indistinguibile da un test
   che fallisce**: o si accorcia o si alza il limite, ed è una decisione.
40. **🟡 IL PERIMETRO È UNA CONSEGUENZA, NON UNA DICHIARAZIONE — 17 agosto 2026.** Selezione spenta,
   allowlist vuota, perno vuoto: il perimetro live-min **non è deciso, è dedotto** dall'unione di §4.8. Ieri
   valeva **1** (Hong Kong `0xe9b3e28d`, 6 share sotto il minimo del venue ⇒ quotabile **zero**); oggi, a
   flotta spenta e snapshot posizioni scaduto, vale **0**. **⚠ Non è stabile per costruzione**: cambia con
   le posizioni. Il perno è ciò che lo rende **stabile e nominato**, vive nel processo, e scriverlo richiede
   `ecosystem.config.js` + riavvio **dal file e insieme** (§2 r.2). **Non impostato**: è un atto di armamento.
31-bis. **🟢 LA DISTANZA DEI LUNGHI È A 3,0¢ DAL MID; I CORTI STANNO A 3,5¢ — 23 agosto 2026.**
   **⚠ QUESTA VOCE DICEVA «LUNGHI 3,5¢ (0,7778)» E LE DUE FASCE ERANO INVERTITE.** Letto il 23/08 alle
   15:35Z: `agents/ecosystem.config.js:148` porta `const DISTANZA_LUNGHI_FRAZIONE_V = String(3.0 / 4.5)`
   = **0,6666666666666666 ⇒ 3,000¢**, e `/proc/<pid>/environ` di **entrambi** i processi conferma
   `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V=0.6666666666666666` — i due processi **concordano fra loro**,
   quindi nessun prezzo divergente (§5.1), era il documento a essere indietro. I **corti** stanno a
   `MAKER_DISTANZA_CORTI_CENTS='3.5'` (`ecosystem.config.js:676`, letto in `/proc` di agent41 e
   confermato dal referto di selezione: `distanzaCorti.cents 3.5 · fonte ambiente`) — quindi **§5.2 p.64
   è superata: i corti NON sono più a 3,0¢**. Il testo qui sotto è la storia della decisione, non lo stato.
   ⚠ **UN SOLO PUNTO**: `const DISTANZA_LUNGHI_FRAZIONE_V` in `agents/ecosystem.config.js`,
   referenziato dai blocchi `env` di agent40 **e** agent41 — erano due letterali, cioè il reperto D1
   su un **prezzo di ordini veri**. ⚠ **3,5¢ è il tetto che il codice già imponeva**: il margine dal
   bordo di §4.1 vale `max(1 tick, 0,22·v)` = 1,0¢, quindi il punto più esterno raggiungibile è
   `4,5 − 1,0 = 3,5¢`. ⚠ **Costa premio e va saputo** (`S = ((4,5−s)/4,5)²`: 0,2959 a 2,05¢ contro
   0,0494 a 3,5¢, **un sesto**). Il ripristino è in `APERTI.md`. ⚠ Si riavviano **entrambi** i
   processi (§5.1). Il conto del margine su 88 mercati: `docs/misure-e-tarature.md`.
31. **🟡 LA MANOPOLA DELLA DISTANZA RESTA A 0,95 — SCELTA, NON DERIVA (16 agosto 2026).**
   `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V: '0.95'`. Da sola costerebbe il 99,6% del punteggio, ma **non decide
   più il punto d'arrivo**: il margine dal bordo di §4.1 riporta l'ordine a 3,4-3,5¢ dal mid, S ≈ 0,05, venti
   volte il bordo nudo. 0,95 è il modo di chiedere il **bordo esterno**. **⚠ Cambiarla richiede il riavvio
   COORDINATO dei due processi** (§5.1): `node scripts/cli/distanza.js`.
34. **🟡 IL MARGINE DAL BORDO NON È DICHIARATO NELL'ECOSYSTEM, ED È VOLUTO (16 agosto 2026).**
   `MAKER_DISTANZA_MARGINE_BORDO_TICK` e `…_FRAZIONE_V` sono env ma **non** stanno in
   `ecosystem.config.js`: entrambi i processi prendono lo stesso difetto dal codice, quindi un riavvio
   scoordinato **non può** farli divergere. Il prezzo: per cambiarlo si tocca `distanza-obiettivo.js` e si
   riavviano **entrambi**. Volendolo per-processo, va aggiunto **a tutti e due insieme**.
35. **🟡 LA ROTAZIONE TOGLIE IL TETTO SUL NUMERO DI MERCATI ESPOSTI (16 agosto 2026, per decisione).**
   §4.13: tre quotano, N completano. Restano il tetto per mercato ($61,25), `maxOpenNotionalUsd`
   (**$650** dal 18 agosto, era $150) e il kill a $100/giorno. **Non è misurato quanti mercati possano stare in gestione insieme** su book veri:
   §5-bis p.162 dà il 32,1% dei fill chiusi in 28,6 min mediani, ma su altri wallet. **Da guardare al primo
   giro vivo prima di alzare il cap.**
36. **🟡 `npm run build` FALLISCE: manca `lucide-react`, causa preesistente (16 agosto 2026).**
   `app/components/ui/Redacted.tsx` lo importa e non è in `package.json`: caduto con la riduzione. Il build
   stampa `✓ Compiled successfully` e muore **dopo**, nel type-check — tutto il JS compila. **Non
   installato**: è una decisione, e il `dashboard` non è nella flotta. Al suo posto: suite e selfcheck.
37. **✅ CHIUSA IL 19 AGOSTO** — l'invariante è **`cap ≥ esposizione massima raggiungibile`** (N
   coppie a riposo **più** il loro completamento), definizione unica in
   `concentration.esposizioneMassimaRaggiungibileUsd(N)`. **⚠ Non si scende sotto**: un tetto che
   impedisce di CHIUDERE non è un limite di rischio, è un rischio. Diagnosi:
   `docs/registro-voci-chiuse.md`.
22. **🟡 IL PIANO SI SVUOTA, E LA CAUSA NON È IL FILTRO DI PROFONDITÀ** (13 agosto 2026). Il cancello che
   decide è `pavimentoPremiante(minSize) > tetto per mercato`: 56 mercati su 102 contro i 5 della
   profondità. ⚠ Rimisurato il 17/08 a $147 (`cancello-a-capitale-piccolo.js`): **40 righe candidabili** su
   147, e a togliere di più è la **SELEZIONE** (−86: ≥24 h, meteo) contro il pavimento premiante (−21); il
   tetto per ordine e la quota del 60% tolgono **zero**. La leva è più capitale, non un tetto più alto.
2. **`REALLOC_SCHEDULER_DRY_RUN` viveva nella descrizione in memoria di pm2**, non nel dump né in `.env`.
   ⚠ **Con la migrazione quella memoria è sparita** (pm2 nuovo, nessun dump): oggi la variabile è **assente
   ⇒ freno INSERITO**, fail-closed. Resta la regola: `--update-env` **fonde**, non sostituisce, e l'unica
   rimozione è `pm2 delete` + `pm2 start`.
3. **Nota minore**: l'header di `strategia-merge.js` elenca quattro ragioni per cui il merge «non è
   eseguibile» e il relayer ne ha tolte tre (solo un commento).
4. **Nessun processo sorveglia il battito di agent40** (agent37 rimosso il 9 agosto, voluto). A togliere
   gli ordini restano la **GTD nativa** del venue e, sul lato economico, `agent43-guardian`.
5. **La ricostruzione del piano non conosce lo scope del rinnovo**: `auto-reprice` itera
   `cfgState.enabledMarketIds`, quindi un mercato fuori dal piano non viene visitato e i suoi ordini muoiono
   per GTD in 23 min. **Decisione documentata**, ed è perché la gamba orfana non si controlla là.
7. **La ricostruzione sotto soglia scatta quasi a ogni giro** (6 righe contro una soglia di 12): ~13 s di
   figlio ogni 10 min. È corretto, ma se il board si allargasse stabilmente vale la pena rimisurare.
13. **La soglia sulla derivata per la sentinella è misurabile: 85%** (§5-bis p.140). Non implementata.
19. **🟡 LA CADENZA ADATTATIVA È SOTTO-RISOLTA — sola misura.** agent40 classifica il **99,6%** delle
   osservazioni «lenta» (10.000 ms) mentre `leggiFinestraTutti` su 15 min vede `rangeMid = 0` sul **48,8%**:
   il conto non torna, il divario non è spiegato. Non è la leva.
9. **🔴 LA SENTINELLA VEDE IL VUOTO, NON IL COLLASSO — buco aperto, 13 agosto 2026.** Il ramo ③ di
   `sentinella-vuoto.js` dice «`ordiniARiposo > 0` ⇒ il libro non è vuoto» e azzera l'orologio: un calo da
   **23 ordini a 2** — il 91% — è invisibile. È tarata sul caso ESTREMO, non sulla derivata. **Non
   implementata**: la cura è un secondo criterio (calo relativo su finestra) e va tarato su quanto oscilla
   normalmente il numero di ordini, misura che oggi non esiste. Non si aggiunge una soglia a occhio a un
   presidio. (L'85% di §5-bis p.140 è per la COPERTURA, non per il conteggio: due grandezze diverse.)
10. **Il costo di `profondita-non-verificata` NON è misurabile dallo stato salvato.** L'esclusione vive in
   `allocator.js:1104`, che gira in un **processo figlio**; `realloc-ultimo-piano.json` persiste **solo
   `righe`** (i vincitori) e **nessun file conserva gli scartati**. Zero occorrenze in 4 giorni perché quel
   giornale non è dove finiscono: **non è che nessuno l'abbia guardato, è che nessuno lo scrive.** La cura è
   l'istogramma dei `reasonCode` scartati accanto a `righe`; senza, non si tocca agent34.
11. **I ROSSI NOTI RUOTANO NEI NOMI, NON NEL CONTEGGIO.** Chi confronta confronti i **NOMI** (§5-bis
   p.134): cambiano da soli col board, e un membro nuovo non è una regressione — ma va verificato che il
   rosso non tocchi il codice modificato. **Non parte**: `leg-order` (test JS su moduli TypeScript).
   ⚠ **IL CONTEGGIO DEL 19/08 ERA INVECCHIATO: il 21/08 la suite dà 240 test · 231 verdi · 8 ROSSI ·
   1 non parte.** Gli 8 sono stati verificati **uno per uno anche sul sorgente PRE-correzione D-A**
   (agent41 riportato a HEAD e rieseguiti): **rossi anche prima, stessi nomi, nessuno introdotto**.
   Sono `dipendenze-mai-iniettate` · `distanza-2c` · `end-of-scale-cycle` · `tetti-per-giro-e-scope` ·
   `tre-fix-sicurezza` (timeout, §5.2 p.42) · `categoria-mercato` · `tetto-derivato-dallo-scaglione` ·
   `tetto-e-scoperta`. **Chi confronta confronti i NOMI, e li rilegga: il numero qui sotto è storia.**
   **Rossi: 2 su 229, verificati il 19/08 su albero COMMITTATO** (erano 12 la mattina del 19, e 10 il
   17/08 su 209 test — l'elenco di allora non vale piu': `dipendenze-collegate`, `scaduto-senza-rinnovo`,
   `scadenza-ereditata`, `end-of-scale-cycle`, `tetto-e-scoperta`, `cancellazione-riconosciuta` sono
   verdi). Restano **i due che dipendono dai DATI VIVI**, non dal codice:
   `categoria-mercato` (12,0% non classificato contro un limite del 2%) e `velocita-mercato` (mediana
   del board 15,2%) — **ruotano col board**, e vanno riletti come misura, non come regressione.
   ⚠ **I tre del tetto di esposizione sono CHIUSI il 19/08** (§5.2 p.37): l'invariante è stata riscritta
   sulla grandezza giusta — `cap ≥ riposo + completamento` — non ammorbidita, e il cap resta $650.
   ⚠ **Gli 8 rossi di `c919981` sono stati RISCRITTI, non ammorbiditi** (19/08): le loro fixture non
   portavano l'età del book, quindi ricevevano `skip/book-non-databile` e non arrivavano al codice che
   provavano. Fixture con book **databile** + un blocco per file che **difende il gate sul proprio
   percorso**, ognuno col suo **CONTROLLO**. Prova esaustiva in un posto solo:
   `lib/maker/bid-databile.test.js` (34/34), che include l'eccezione R6 e verifica **per assenza** che
   il merge non sia toccato (`decidiLivello` non riceve affatto `rules`, quindi R8 regge).
   ⚠ **`hook-piazzamento` e `policy-permessi` sono USCITI dai rossi** (70/0 e 84/0): erano rossi per due
   percorsi `/root` morti, non per un difetto — §5-bis p.188. ⚠ `tre-fix-sicurezza` compare fra i rossi
   della suite ed è un **timeout**: eseguito da solo fa **42/0** (§5.2 p.42).
   ⚠ **E due rossi nuovi del 17/08 sera erano MIEI, difendevano la proprietà vecchia, e sono stati
   RISCRITTI non ammorbiditi**: `miniciclo-prende-il-mercato` asseriva «la corsia manuale chiede live-min
   a prescindere da `MAKER_MODE`» — vero fino a ieri, falso apposta da oggi (§4.14) — e
   `cablaggio-di-produzione` fotografava i due letterali `/tmp/...` invece della proprietà «non li
   ridichiara». **Lo strumento**: `node scripts/ricerca/suite-rossi.js <nome>`.

### 5.3 · Trappole operative — da rileggere prima di lavorare

- **Un percorso assoluto è un difetto che aspetta** (§5-bis p.188: dodici maturati in una volta sola).
  La forma pericolosa non è che il file manchi: è che **ogni lettore ha già un ramo per «non l'ho
  letto»**, e quel ramo si prende la scena — `readJson` → `null` ⇒ board **vuoto**; `codaNuova` → `''` ⇒
  «il guardiano non ha detto niente»; `diff` che esce **2** ⇒ **zero differenze**, cioè un cancello che
  si apre. Si ancora al package root (`lib/safety/store.DATA_DIR`, che salta le directory di build), a
  `__dirname/..`, a `os.homedir()`, o si chiede a git — mai a una stringa. **E si cerca il GEMELLO**:
  correggere solo il lettore fa divergere due percorsi per lo stesso file, in silenzio (reperto D1).
- **Una directory CONDIVISA fra utenti è la stessa trappola, in peggio**: `/tmp` ha lo sticky bit, quindi
  dopo un cambio di utente i file del proprietario vecchio non sono né riscrivibili né **cancellabili**.
  Gli scrittori prendevano EACCES **e i lettori continuavano a leggere la copia vecchia, che da quel
  momento non invecchiava più** — un prezzo di quaranta minuti prima presentato come di adesso, cioè una
  direzione di guasto peggiore di «il file manca». Adesso la directory è **per utente**
  (`lib/percorsi-runtime.js`, `/tmp/rewards-bot-<utente>`, 0700) e `lib/safety/percorsi-critici.js` si
  ferma **rumorosamente** all'avvio se un file di servizio esiste e non è scrivibile. ⚠ Non pretende che
  i file esistano: assente è il primo avvio, ed è sano.
- **`pgrep -f <nome>` non è affidabile qui**: il comando che lo esegue contiene il nome cercato, quindi
  `pgrep` trova la propria shell. Per l'ambiente di un processo pm2: pid da `pm2 jlist`, poi
  `/proc/<pid>/environ`.
- **Due `npm run build` insieme si distruggono a vicenda**: il secondo rimuove `.next/static/<BUILD_ID>`
  che il primo stava riempiendo. Sintomo: il BUILD_ID nell'errore **non** è quello in `.next/BUILD_ID`.
  Un `.next` incompleto manda il **dashboard** in crash loop al riavvio — **verificare
  `.next/prerender-manifest.json` PRIMA** di riavviarlo.
- **Un `.d.ts` scritto a mano può ROMPERE il build**: un'interfaccia con index signature
  (`[k: string]: unknown`) è più **stretta**, non più larga, e TypeScript rifiuta il tipo vero. Si
  importa il tipo esistente, non se ne scrive un gemello. E un modulo JS nuovo importato da una rotta
  TS senza `.d.ts` fa inferire i parametri dai valori di difetto (`= null` ⇒ `null | undefined`).
- **Un test che guida `miniCiclo` deve iniettare `scriviTetti` E `pianoLeggero`**, o riscrive i tetti
  VERI e fa partire il pianificatore vero sul board vivo (nondeterministico e lento).
- **Una dep col nome sbagliato non è un errore: è un valore di difetto che nessuno ha chiesto.** Quattro
  occorrenze in questo repo (`readDepth` non iniettato, `signerProvider` non cablato, `{file}` invece di
  `{auditFile}`, `deps.stato` con `||` invece di `!== undefined`). Un test che inietta una dep dovrebbe
  **misurare** che la dep sia stata usata.
- **`Number(null) === 0`**: **sei** occorrenze in questo repo, tutte trovate da una prova e mai dal
  ragionamento. «Non ho letto» che diventa «non c'è» è il difetto più ricorrente qui dentro.
- **La truthiness di `find` non è un test di esistenza**: in un array che può contenere valori falsy,
  «esiste un elemento che…» si scrive con `findIndex` o `some`.
- **Un walker dei `require` per regex trova anche i `require` dentro le STRINGHE** — e `RUNNER_PIANO` è
  esattamente una stringa che contiene `require(".../allocator")`. Qui la differenza è fra «serve un
  riavvio» e «non serve».
- **I test strutturali devono filtrare i commenti**: un commento che *racconta* la riga corretta ha già
  fatto passare un test che cercava la stringa nel sorgente.
- **Non asserire su `git diff` né contare occorrenze**: un test che fotografa il working tree è verde
  durante la lavorazione e rosso un minuto dopo il commit. Si difende la **proprietà**, non il conteggio.
  (Successo tre volte: §5-bis p.71, p.115, e il 13 agosto su `capitale-senza-doppio-conteggio`.)
- **Il piano nasce in un PROCESSO FIGLIO** (`RUNNER_PIANO`, `/api/rewards/allocate`) che rilegge il
  codice da disco: le modifiche a `lib/rewards/allocator.js` sono in servizio **senza riavvio**. Quello
  che vive nel processo di agent41 sono le righe di log e il cablaggio.
- **L'hook di piazzamento — QUANDO ERA ARMATO — bloccava anche un ciclo di agent41 lanciato a mano**, e
  anche un heredoc di documentazione che *nomini* una funzione di piazzamento. ⚠⚠ **DAL 19 AGOSTO 2026
  L'HOOK È DISARMATO E LE 164 REGOLE `ask` SONO STATE TOLTE** (v. §2, «Permessi della sessione e hook»):
  la frase «non si aggira» **non descrive più uno stato del sistema**. Oggi l'unico presidio sui
  piazzamenti è la **regola 3 di §2** — conferma esplicita dell'utente in chat, ogni volta — e resta la
  buona pratica di far eseguire il comando all'operatore e di usare lo strumento di scrittura file invece
  di `cat <<EOF`.

---

## 5-bis · REGISTRO DELLE VOCI CHIUSE — **SPOSTATO IN `docs/registro-voci-chiuse.md`**

**A cosa serve.** Le decisioni vive stanno in §3 e §4; il registro serve a risolvere un riferimento come
«§5 punto 72» o «§5-bis p.204» sparso nei commenti del codice, e a sapere *che* un problema è già stato
incontrato. Il dettaglio integrale è in `git log` e nei commit citati nei sorgenti.

> 📄 **`docs/registro-voci-chiuse.md`** — verbatim, niente tolto: le voci **1-205** (titolo e diagnosi), le
> sezioni del 13 agosto, il registro completo 1-119, e le voci di §5.2 chiuse (p.37, p.49, p.54, p.57).
> **Le ultime cinque, per orientarsi**: p.205 da 5 a 10 mercati e cap $1.300 · p.204 le due fonti del
> totale si riconciliano sul VALORE · p.203 vista board 150→300 · p.202 il riferimento del guardiano sale
> solo su conferma · p.201 l'OOM del figlio del piano.
> **⚠ Chi chiude una voce di §5.2 la sposta LÌ, non qui**, e lascia in §5.2 la riga «✅ CHIUSA».

### Le classi di difetto che si ripetono — leggerle prima di scrivere codice qui

| classe | quante volte | forma |
|---|---|---|
| `Number(null) === 0` | **6** | «non ho letto» diventa «non c'è», e il ramo sbagliato parte |
| costante ricopiata invece che importata (rilevatore **D1**) | 5+ | due numeri per lo stesso concetto che divergono in silenzio |
| protezione presente su un percorso e assente su un gemello | 5+ | `already-covered`/`close-at-market`/`skip`, i quattro punti della copertura |
| dep non cablata ⇒ valore di difetto che nessuno ha chiesto | 4 | `readDepth`, `signerProvider`, `{file}`, `deps.stato` con `\|\|` |
| commento che descrive un comportamento inesistente (**D7**) | 4+ | il commento è ciò che si legge, il codice ciò che accade |
| test che fotografa il codice invece della proprietà | 3 | verde in lavorazione, rosso dopo il commit, senza nessun difetto |
| filtro a monte che svuota l'eccezione scritta a valle | 2 | «l'eccezione è scritta?» ≠ «la riga arriva fin qui?» |


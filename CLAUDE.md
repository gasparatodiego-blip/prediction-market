# CLAUDE.md — contesto permanente del progetto

Questo file viene letto automaticamente all'avvio di ogni sessione Claude Code aperta da
`/home/bot/bot`. **Il contesto vive qui, non nel prompt.**

Ultima verifica contro codice/stato reali: **22 agosto 2026** (§4.13 a 10 mercati, cap $1.300, guardiano
riconciliato — §5-bis p.204/205). Le cinture si leggono da `/proc/<pid>/environ` degli 11 processi vivi.
Il quadro del giro è in `APERTI.md`.

> ⚠️ **QUESTO FILE È STATO POTATO DUE VOLTE**: il **13 agosto 2026** (494k → ~110k) e il **22 agosto
> 2026** (202k → **~119k**), entrambe su istruzione dell'operatore. **Non è stata tolta nessuna regola,
> nessuna costante, nessuna trappola operativa e nessuna questione aperta**: è stata tolta la
> **cronologia**, cioè il racconto di come si è arrivati a decisioni che oggi sono semplicemente vere.
> **Niente è stato cancellato: tutto è stato SPOSTATO**, e la verifica è meccanica — ogni riga del
> CLAUDE.md pre-potatura esiste verbatim o qui o sotto `docs/` (controllo: **0 righe non ritrovate**).
>
> | file | cosa contiene |
> |---|---|
> | `docs/registro-voci-chiuse.md` | **§5-bis per intero**: le voci chiuse **1-205** col numero originale (così «§5 punto 72» resta risolvibile), le sezioni del 13 agosto, il registro 1-119, più le voci di §5.2 **chiuse** (p.37, p.49, p.54) con la diagnosi integrale |
> | `docs/episodi-chiusi.md` | I quattordici riquadri narrativi che stavano in cima a CLAUDE.md: il fatto, la misura e la diagnosi di episodi già corretti |
> | `docs/storia-per-sezione.md` | Per ogni sezione potata (§1, §2, §3, §4.1, §4.1-bis, §4.2, §4.4, §4.6, §4.7, §4.8, §4.9, §4.10, §4.11, §4.12, §4.13, §4.14, §5.1, §5.3) il **testo integrale prima della potatura** |
> | `docs/permessi-e-hook.md` | La policy dei permessi (164 regole `ask`, le tre famiglie, le 19 forme di scrittura) e l'hook `blocca-piazzamento.js` per esteso |
>
> **⚠ Le questioni APERTE di §5.2 sono rimaste qui per intero e non si spostano.** Chi chiude una voce
> la sposta in `docs/registro-voci-chiuse.md` e lascia in §5.2 una riga «✅ CHIUSA» col rimando.
> **Chi aggiunge una voce nuova scriva già compatto.**

---

> ## ✂️ DOVE VIVE IL BOT, E COM'È ARMATO
> **⚠⚠ IL REPO È IN `/home/bot/bot` E L'UTENTE È `bot`.** `/root` non è leggibile: ogni percorso
> assoluto che dica `/root/...` è **storia, non stato** (§5-bis p.188). pm2 **7.0.3** sotto
> `/home/bot/.pm2`, PostgreSQL **16**, database e utente `rewardsbot`, **14 tabelle**; `.env` gitignored,
> `chmod 600`. **⚠ I FILE DI SERVIZIO NON SONO IN `/tmp` NUDO** ma in `/tmp/rewards-bot-<utente>`
> (0700), definizione unica in `lib/percorsi-runtime.js` (§5.3).
> **LA RIDUZIONE (15/08)**: 568 file su 1.267 **spostati** — mai cancellati — in `_archivio`, che
> conserva i percorsi (`mv _archivio/<p> <p>` riporta indietro; `INDICE-SPOSTATI.json` è l'elenco). La
> catena serve **486 file**. **⚠ `_archivio` è ESCLUSO dai sei test strutturali che camminano l'albero.**
> ## 🔴🔴 IL BOT È ARMATO E OPERA CON CAPITALE VERO — dalle 16:21Z del 18 agosto 2026
> **STATO LETTO DAI PROCESSI VIVI**: flotta a 11 processi ONLINE (§5.1) · `MAKER_MODE=live-min` ·
> `MAKER_ADAPTER_DRYRUN=false` · **`MANUAL_ORDER_PLACEMENT=send`** su agent40 **e** agent41 · freno di
> agent41 `=0` ⇒ **ZERO CINTURE INSERITE, 0/4** (§4.14) · **`MAKER_MERCATI_CONTEMPORANEI=10`** su agent41
> (R1, dal 22 agosto 2026) · `SLOT_STERILE_ARMATO=0` · KILL spento · selezione automatica **ACCESA** ·
> perno **vuoto**.
> ⚠ **QUANTI ORDINI CI SIANO A LIBRO NON SI SCRIVE QUI: SI LEGGE**, da `data/venue-orders.json`, che
> agent40 scrive da letture VERE del venue — **non** ricostruendolo dal giornale sommando i `sent` e
> togliendo le scadenze registrate. **Una ricostruzione non è una lettura**: il 18 agosto sera così sono
> stati dichiarati «4 mercati, 8 ordini, $209,08» mentre al venue ce n'erano 2.
> **⚠ CIÒ CHE RESTA DAVANTI NON SONO PIÙ CINTURE, È STATO DEL SISTEMA**: il KILL, il tetto per ordine
> ($65,63), il tetto per mercato ($61,25), l'esposizione cumulativa (**$1.300**, §4.2), il rate limit,
> la perdita giornaliera a **−$100**, «mai primo sul libro» e la banda premiante. **Il freno vero è il
> kill a −$100**, non il tetto di esposizione.
> **⚠ `MAKER_MODE` NEL `.env` DICE ANCORA `off`, ED È INERTE**: pm2 tiene la propria copia dell'ambiente
> e i caricatori `.env` scrivono solo le chiavi **assenti**. Quello che conta è
> `agents/ecosystem.config.js` + riavvio **dal file**. ⚠ `scripts/cli/stato.js` stampa una riga «`.env`
> (cosa entrerebbe al prossimo riavvio DAL FILE)» che è **sbagliata e rassicura**: legge il solo `.env`.
> **Da correggere.**
> **⚠ OGNI RIAVVIO DI agent40 ABBANDONA GLI ORDINI GIÀ A LIBRO**: al suo avvio diventano
> **PRE-ESISTENTI**, cioè «invisibili al motore — non riprezzati, non rinnovati, non cancellati»
> (`lib/maker/ordini-preesistenti.js`, regola voluta). Con `send` aperto **un deploy condanna il libro
> esistente alla morte per GTD** — misurato il 18 agosto: due ordini veri morti così.
> **I COMANDI CHE SOSTITUISCONO IL PANNELLO** (`scripts/cli/`, ognuno dichiara cosa sta per cambiare e
> cosa ha cambiato): `mercati.js` · `distanza.js` · **`stato.js`** · `avvia.js` · `ferma.js` ·
> `selezione.js`. Passano dagli **stessi moduli** degli agent. **Nessuno può accendere la modalità
> viva.** `avvia.js` **LEGGE il KILL e si rifiuta di partire mentre è attivo, senza spegnerlo**.
> `stato.js` verifica su di sé, camminando `require.cache`, di non aver caricato nessuna superficie che
> sappia agire sul venue, e legge cinture e numero di mercati da `/proc/<pid>/environ`.
> **LE VERIFICHE, in ordine di quanto provano**: **il banco del ciclo completo**
> (`node scripts/ricerca/banco-scenari.js`: **26 passi su 26**, le dieci regole concordate tutte provate,
> deterministico e **identico su due snapshot diversi di `data/`**) · **le quattro cinture una alla
> volta** (`node scripts/ricerca/prova-cinture.js`, 10/0, col controllo) · la suite `lib/`
> (`node scripts/ricerca/suite-rossi.js <nome>`, che confronta i **NOMI** e non il conteggio, §5.2 p.11)
> · i 5 selfcheck di `scripts/` · `node scripts/verifica-catena-rewards.js`.
---

> ## ⚖️ LE DIECI REGOLE CONCORDATE — 18 agosto 2026, decise dall'operatore
> **Sono la SPECIFICA del bot, e il testo integrale con `file:riga` e il passo del banco che le prova
> sta in `APERTI.md` §0.** Qui resta il riferimento, perché chi cambia una di queste cambia il bot.
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
> **⚠ CHI CAMBIA UNA REGOLA DEVE CAMBIARE ANCHE IL SUO PASSO DEL BANCO** (18-23), o la prova resterebbe
> a difendere la regola vecchia — che è esattamente come tre difese sono rimaste inerti col verde (p.181).
> **⚠ DUE DIVERGENZE CONFERMATE, dove il codice è PIÙ PRUDENTE della regola e resta com'è**: il margine
> dal bordo è `max(1 tick, 0,22·banda)` e non un tick; il kill **non ha auto-riarmo affatto**.

---

## 🟢 STATO OPERATIVO — vedi i due riquadri qui sopra (18 agosto 2026, letto dai processi vivi)

Capitale all'ultima lettura di agent41: **$1.497,04**. Guardiano perdite in servizio,
`data/guardian-state.json` assente (l'assenza *è* lo stato sano). Una sola posizione residua: Hong Kong
`0xe9b3e28d`, 6 share a carico 0,50, **non chiudibile** (sotto il `min_incentive_size` di 20, §5.2 p.1).

> ## 🔻 IL GRADINO 6 È DISARMATO — decisione dell'operatore, §5-bis p.153/159
> `SBLOCCO_GRADINO6_ARMATO='0'` nell'`env` di agent41. Non è un difetto: armarlo metterebbe il bot su
> **FERMA senza riarmo automatico** — una mano umana per ripartire, con la causa a monte ancora aperta.
> **⚠ DISARMATO NON VUOL DIRE ASSENTE**: la scala sale ancora fino a 6 e il gradino **registra che
> sarebbe scattato e perché** (`data/realloc-scheduler.jsonl`, `disarmato:true`; giornale maker,
> `outcome:'gradino-6-disarmato'`). Conta **episodi**, non tick.
> **⚠ NESSUNA DIFESA VERA È TOCCATA**: guardiano delle perdite, sentinella del collasso e KILL non
> passano da questa scala, e un test lo verifica per assenza.
> **PER RIARMARLO**: si cancella quella riga da `agents/ecosystem.config.js` e si riavvia agent41. Il
> difetto **in assenza della variabile è ARMATO** — un env che sparisce non può spegnere una difesa.
> ## 📚 I QUATTORDICI EPISODI CHIUSI — narrativa in **`docs/episodi-chiusi.md`**, qui solo le REGOLE VIVE
> **Dove sono finite le regole**: il **vuoto di tre ore** ⇒ §4.3 (griglia limitata anche dal tetto, 8
> livelli minimi) + sentinella sul vuoto (5 min) + recupero della scadenza a tre fonti (§4.6) · il
> **capitale al lavoro** ⇒ §4.5 · **dove muoiono le gambe** (65% erano coppie abbandonate INTERE perché
> UNA gamba sfondava il tetto per ordine) ⇒ §4.2 · **quanti mercati vede il bot** ⇒ §4.7 e §5.2 p.55 ·
> la **scala di urgenza** ⇒ §4.6 · i **residui sotto il minimo** ⇒ §4.6 (uscita anche dal libro da R6) e
> il riscatto on-chain, bloccato adesso **$3,00** · il **guardiano k=2** ⇒ §3.
> ⚠ **Pannello Polymarket e bot misurano cose diverse e possono essere entrambi giusti**: «disponibile
> per il trading» **è il cash** e non sottrae i BUY a riposo; il bot conta **posizioni + ordini a riposo**.
> ⚠ **`ultimoCicloOk` si timbra in TRE punti** — a fine giro e nei due rami «nessuna azione», perché
> anche un giro che non trova niente HA girato.
> **🤖 IL BOT SI SBLOCCA DA SOLO** (p.124-127) — **principio: ogni difesa AGISCE, non segnala soltanto**;
> e la metà opposta, **quando l'unica via d'uscita violerebbe una regola di rischio il bot non agisce e
> lo dichiara**. **①** `sblocco-progressivo.js`: **5** rifiuti identici di fila sulla stessa coppia
> (mercato, gate) sono un blocco strutturale; **37 famiglie** in tre classi — `rischio` (56% dei rifiuti)
> ⇒ nessuna azione, si cambia mercato e si dichiara perché · `stato-bot` ⇒ via alternativa vera ·
> `transitorio` ⇒ non è un blocco. **Famiglia sconosciuta ⇒ trattata come rischio.** **②**
> `coerenza-soglie.js`: prima di proporre righe si verifica che chi le riceve le accetti, e il capitale
> **può solo SCENDERE**. **③ SCALA DI SBLOCCO**, un gradino ogni **5 minuti**: `ricostruisci-piano` →
> `ricarica-configurazione` → `riconcilia-esposizione` → `ripara-precondizioni` → `risveglia-feed` →
> **`fermati-in-sicurezza`** (gradino 6, **DISARMATO**, v. riquadro sopra). Caso peggiore: FERMA in ~30
> minuti. **Nessun gradino tocca una regola di rischio**, per struttura. **④ AUTODIAGNOSI ogni 120 s**:
> ordini vivi > 0 · capitale al lavoro ≥ **50% per 15 minuti** · un ciclo negli ultimi **20 min** ·
> rinnovi dovuti non fermati oltre l'**80%**. Tutto illeggibile ⇒ **non si giudica** e la scala non parte.
> **💰 RISCATTO AUTOMATICO DOPO LA RISOLUZIONE** (`lib/maker/riscatto-automatico.js`, agganciato alla
> scansione dei registri di agent40): **⚠ il segnale è `payoutDenominator(conditionId) > 0` LETTO
> ON-CHAIN, non «il mercato è chiuso»** — `closed`/`acceptingOrders` diventano veri ore prima che
> l'oracolo riporti l'esito, e un tentativo prima è un revert che costa gas. **Non letto ⇒ non si
> riscatta.** **Idempotente** con registro su disco (`data/riscatti.json`), **3 tentativi** poi **10
> minuti** di backoff per mercato, al più **3 mercati per giro**. `negRisk` non booleano ⇒ non si tenta.
> **🧹 QUARANTENA VENUE**: il board è sporco per una **CLASSE** di mercati (`premio-crollato`) e tre
> passate contro N mercati sporchi non convergono. Si pulisce la fonte: l'esito della verifica al venue
> **sopravvive al ciclo** (`quarantena-venue.js`, **20 minuti**). **Non è un cancello**: un mercato in
> quarantena che arrivasse al piazzamento sarebbe giudicato da tutti i gate come prima.
> **📉 SENTINELLA SUL COLLASSO DELLA COPERTURA — SOLO OSSERVA**: calo **≥ 85% dal MASSIMO delle ultime 10
> minuti**, non fra campioni consecutivi (la cadenza è irregolare e un crollo in due campioni verrebbe
> spezzato). **85 e non 80 perché il divario è VUOTO**: fisiologico massimo 75%, patologico minimo 92,9%.
> **⚠ Non si auto-inganna**: se un latch del guardiano cade nei **15 minuti** precedenti, il calo è
> **SPIEGATO** e non si arma; latch illeggibile ⇒ non si arma. **⚠ Log e giornale soltanto**: non ferma
> il bot e non tocca AVVIA/FERMA, e un test lo verifica **per assenza**.
> **🪙 LA GAMBA SORELLA SI ABBASSA DENTRO LA BANDA**: quando il tetto della coppia cade **sopra** il bordo
> alto della banda premiante si scende fino al bordo — la controparte costa meno e l'ordine matura reward
> mentre aspetta. **⚠ Non allenta niente**: è un `Math.min`, il prezzo può solo scendere; banda non
> leggibile o bordo sopra il tetto ⇒ prezzo **identico a prima**.
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

`.claude/settings.json` (progetto) e `~/.claude/settings.json` (utente) portano una **copia identica**
della stessa policy: `allow` ampio + **164 regole `ask`**. `ask` batte `allow` da qualunque file arrivi,
e le regole si **fondono**. `.claude/settings.local.json` deve restare privo di regole `ask`. Le due
copie vanno tenute in sync, e `lib/safety/policy-permessi.test.js` fallisce se divergono.

**Le tre famiglie, con criteri diversi apposta:** **①** capitale reale ⇒ `ask` **anche in lettura**
(ordini manuali, script di piazzamento, gli env che armano): basta *nominare* la cosa. **Questa
famiglia non si allarga.** **②** pm2 ⇒ `ask` **se nominato** (`restart`/`stop`/`delete`/`reload`/
`kill`/`startOrRestart`); `list`/`describe`/`env`/`logs` passano. **③** flag di stato e sicurezza ⇒
`ask` **solo in scrittura**, con la stessa famiglia di **19 forme** per ognuno dei sei flag (redirezione,
`tee`, `sed`, `rm`, `mv`, `cp`, `touch`, `truncate`, `dd of=`, esecuzione via interprete, `git
checkout`/`restore`/`reset`, `curl`/`wget` sulle rotte, `Edit(...)`); la lettura passa in autonomia.
⚠ **Eseguire** un file che nomina il flag chiede **anche quando è il suo stesso test**.

**L'hook** `.claude/hooks/blocca-piazzamento.js` (`PreToolUse`/`Bash`, ancorato a
`$CLAUDE_PROJECT_DIR`) **apre il file e cammina il grafo dei `require`** fino a profondità 3 cercando la
superficie di piazzamento vera: chiude il caso `node /tmp/x.js` che non nomina niente. **Cancellare non
è in elenco** — può solo ridurre l'esposizione, e il guardiano deve poterlo fare. Tre esenzioni
dichiarate: le letture (valutate **segmento per segmento**), i `*.test.js` del repo (contenuto, non il
comando che li lancia), il **corpo di un heredoc** (torna a contare se va in pasto a `node`).
**⚠ Un riavvio pm2 non passa dall'hook**: i segnali chiedono una *forma di esecuzione* davanti al nome.
Il presidio lì sono le regole `ask` della famiglia ②.

**⚠ Limite dichiarato della famiglia ③**: la copertura è per *forme note* di scrittura, non per
costruzione (`install`, `sponge`, `awk` con redirezione indiretta, `git reset --hard` senza path, una
redirezione senza spazio seguita da altro). **Il presidio vero resta la regola 3 di §2.** Chi aggiunge
un flag di stato aggiunge le **19 forme** — non un pattern sul solo nome — e lo mette nell'elenco `FLAG`
di `lib/safety/policy-permessi.test.js`.

Le sessioni si aprono da `/home/bot/bot`: `claude --permission-mode auto`.

### Guardrail auto-resume

Se il turno corrente è stato aperto da un risveglio automatico (ScheduleWakeup o simile) e **non** da
un messaggio umano: build, test, edit, commit locali restano autorizzati; **`git push` e qualunque
deploy o restart pm2 no**, anche se il prompt che ha programmato il risveglio diceva «senza gate».
Si completa tutto il resto, si dice cosa è pronto, e si aspetta il messaggio umano successivo.

---

## 3 · AGENTI CHIAVE

**LA FLOTTA VIVA È DI 11 PROCESSI** (§5.1) e si legge, non si crede: `node scripts/cli/stato.js`
confronta i definiti e i vivi nei due versi. `agent35-maker` (il motore automatico) e
`agent37-maker-watchdog` (il suo dead-man) **sono stati rimossi il 9 agosto 2026** dal repo e
dall'`ecosystem.config.js`; il `dashboard` non è più nella flotta (le decisioni si prendono da
`scripts/cli/`), ma i sorgenti sotto `app/` restano sul disco perché 32 test strutturali li leggono.

| pm2 | Cosa fa | File |
|---|---|---|
| `agent34-clob-ws` | Feed **websocket** dei book CLOB Polymarket. Sola lettura, canale pubblico e senza chiavi: non può firmare, piazzare o cancellare nulla. Alimenta tape e mid-history. | `agents/agent34-clob-ws.js` |
| `agent38-tape-watchdog` | Watchdog di **continuità** dei giornali (trade tape + mid-history): copre il buco che l'auto-heal del socket di agent34 non vede. | `agents/agent38-tape-watchdog.js` |
| `agent40-manual-reprice` | **Riprezzatura / uscita dalla banda** per gli ordini piazzati a mano: l'asse giusto non è la scadenza a 180 s ma «l'ordine è ancora dentro la banda che paga?». Scrive lo snapshot posizioni. | `agents/agent40-manual-reprice.js` |
| `agent41-realloc-scheduler` | **Riallocazione periodica** (ogni 6 h, due trigger indipendenti: *validità* e *valore*) + **trigger a capitale fermo** (ogni 2 min, un trigger solo: collaterale libero sopra **$50**). **È l'unico processo che può cancellare e piazzare ordini veri senza conferma umana**, per eccezione esplicita dell'operatore. | `agents/agent41-realloc-scheduler.js` |
| `agent42-watch-makers` | Monitor dei **21 maker di riferimento**: ingressi, convergenze, ritiri pre-risoluzione. L'unico processo della flotta che **non può toccare capitale nemmeno in linea di principio** (nessun import da `lib/maker/`, nessuna credenziale). | `agents/agent42-watch-makers.js` |
| `agent24-liquidity-rewards` | Scanner dei mercati con reward: ogni 15 min legge Gamma + book e assegna il punteggio con la formula quadratica esatta del venue. | `agents/agent24-liquidity-rewards.js` |
| `agent27-news-guard` | Guardia notizie/volatilità: segnala che il prezzo sta per muoversi, così le quote si ritirano prima del fill avverso. | `agents/agent27-news-guard.js` |
| `agent43-guardian` | **Guardiano delle perdite economiche** — vedi la scheda sotto. | `agents/agent43-guardian.js` |
| `agent45-osservatore` | **L'osservatore muto.** Un campione ogni **60 s** in `data/osservatore/`: ordini a riposo, mercati con posizione (coppie vs gambe nude), posizioni e valore, saldo, totale, PnL del guardiano, stato degli interruttori, reward di giornata. Più un **giornale in italiano** con gli eventi (pre-allarme, scatto, collasso, transizioni coperta⇄scoperta **con la durata**, merge, cancellazioni). **Non decide, non agisce, non avvisa.** Rotazione giornaliera, 30 giorni. Strutturalmente incapace di toccare capitale — un test cammina il suo albero dei `require`. **Read-only ⇒ riavviabile senza conferma.** | `agents/agent45-osservatore.js` + `lib/osservatore/campionamento.js` |
| `agent-monitor` | Sorveglia la flotta via heartbeat e riavvia gli agenti fermi, con circuit breaker per agente. | `agents/agent-monitor.js` |
| `dashboard` | Il Next.js su porta 3000. **Non è più nella flotta** (§5.1): le decisioni si prendono da `scripts/cli/`. | `npm start -- --port 3000` |

**Non sempre vivo, e apposta — `agent44-audit-scoperta`** (8 agosto 2026). Legge il codice del bot,
cerca i pattern di rischio che in questo progetto hanno già prodotto guasti veri, scrive la coda ed
**esce**: non corregge niente, non tocca ordini né capitale, non scrive nessun file che non sia la
propria coda — provato da un test che cammina il suo albero dei `require`.
**Quando**: `cron_restart: '7 3 * * *'` + `autorestart: false` (fra una scansione e l'altra sta in
`waiting restart`, CPU 0% e RAM 0 MB); le 03 UTC perché sono le ore più quiete misurate ed è l'unica
**dopo** la riconciliazione notturna di agent40. **Quanto costa**: 63-68 s, 99-107 MB di picco, a
**nice 19** e **ionice idle**, deadline 12 min e un vigile interno che si ferma oltre 150 MB.
**Cosa cerca**: sette rilevatori, ognuno nato da un guasto vero — costanti dello stesso concetto con
valori diversi (**D1**) · protezioni presenti su un percorso e assenti su un altro · la stima che
diverge dal consuntivo · flag che nessuno legge più · test rossi (nuovi vs già noti) · collisioni di
numerazione · **commenti fermi a un valore che non è più quello** (**D7**).
**Il report**: `data/audit-coda.json` (memoria) e `data/audit-coda.md` (vista); si guarda con
`node scripts/vedi-audit.js` (`--tutti`, `--storia`). **La memoria**: niente sparisce — un reperto che
non si ritrova diventa **risolto** con la data, uno che torna è **riaperto**, e `primaVisto` non viene
mai sovrascritto. **File**: `agents/agent44-audit-scoperta.js` · `lib/audit/{rilevatori,coda}.js`.

**Il controllo dei percorsi, in tutti e nove gli agent che scrivono.** `lib/safety/percorsi-critici.js`,
chiamato all'avvio: radice del package, `data/` scrivibile, directory di servizio creabile, e ogni file
di servizio **già esistente** scrivibile da noi. Su guasto: stderr + `exit 1` ⇒ sotto pm2 riavvio e poi
`errored` in rosso. ⚠ Un file **assente** non è mai un errore (è il primo avvio, o lo stato sano), e non
si controlla il **contenuto**. Il test costruisce ogni guasto vero e poi lo rimette a posto — un
controllo sempre rosso non distingue niente.

**La scheda del guardiano:**

| | |
|---|---|
| `agent43-guardian` | **Il guardiano delle perdite economiche.** Ogni 30 s confronta (saldo pUSD + posizioni al prezzo corrente) con il **riferimento a massimo mobile** in `data/guardian-baseline.json`. Oltre `GUARDIAN_LOSS_PCT` (**5%**) o la **soglia assoluta DERIVATA** (5% del riferimento; `GUARDIAN_LOSS_ABS` resta il pavimento in dollari) cancella **tutti gli ordini a riposo**, deposita un referto `reason='guardian-auto-kill'` e mette il bot su **FERMA**; non tocca le posizioni aperte e non ferma l'uscita automatica. Le soglie si rileggono da `.env` **a ogni giro**, senza restart. **Strutturalmente incapace di piazzare** (unica superficie: `lib/maker/cancel-all`), verificato da un test che cammina l'albero dei `require`. Dettaglio: §5-bis p.202/204 e `docs/`. Le sei regole che governano: ⟨1⟩ **k = 2 letture** consecutive e contigue prima di scattare. ⟨2⟩ **LE DUE FONTI DEVONO DESCRIVERE LO STESSO ISTANTE** (§5.2 p.54 chiusa): il saldo ha una cache da 45 s e lo snapshot posizioni è tollerato fino a 180 s, quindi durante un fill il totale contava il DEBITO senza il suo ATTIVO. `riconciliaFonti` (pura) pretende che un movimento di **cassa** sia compensato da uno OPPOSTO delle **size** (`Δcassa + Δsize ≈ 0`, tolleranza **$6,00** presa dal divario VUOTO fra $4,95 e $8,32 su 29 movimenti veri); se non lo è, **il totale non è misurabile** e il giro finisce lì. **⚠ Si riconcilia la parte dovuta alle SIZE, non il VALORE**: un movimento di solo prezzo è P&L vero e il guardiano lo deve VEDERE — un criterio sul valore totale lo accecherebbe durante un crollo. **⚠ Costa un giro (30 s) dopo un riavvio** e non smette mai di misurare in silenzio (contatore dei rifiuti consecutivi, `op:'guardian-riconciliazione'` a verbale). ⟨3⟩ **IL RIFERIMENTO SCENDE SUBITO E SALE SOLO SU CONFERMA**: un totale sopra il riferimento è un **candidato** finché una seconda lettura **distinta e contigua** non lo sostiene, e allora sale al **minimo delle due**; un rientro lo scarta. Depositi e prelievi sono cassa esterna, non P&L. ⟨4⟩ **NESSUN RIARMO AUTOMATICO DI AVVIA, per decisione**: sarebbe una **terza** strada autonoma verso il capitale reale dentro il modulo il cui mestiere è fermare. Si riparte cancellando `data/guardian-state.json` **a mano**. ⟨5⟩ **L'AVVISO** (`lib/maker/allarme-guardiano.js`) è cablato come **ULTIMO** passo di `spazzaEFerma`: non può ritardare la spazzata, non può farla fallire (non solleva mai, e il chiamante ha un secondo `catch`), non aggiunge nessuna chiamata nei giri normali — test **per ordine** nel sorgente e **per assenza** dentro `poll`. **⚠ È inerte finché `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` non sono nel `.env`**, e in quel caso lo dichiara nel log. ⟨6⟩ **IL SECONDO INGRESSO — perdita giornaliera realizzata a −$100 — DA R10 CHIUDE ANCHE LE POSIZIONI**: `chiusura-di-emergenza.js` (puro, zero `require`) classifica in **coppie a merge · gambe scoperte vendute attraversando · gambe sotto il minimo LASCIATE e dichiarate**, e agent43 **deposita** `data/chiusura-emergenza-richiesta.json` **senza eseguire** — a eseguire è **agent41**. ⚠ Il presidio dei 60 minuti sta dietro `botAttivo()`, cioè **non gira a bot FERMO**, che è lo stato che il kill produce. ⚠ Il drawdown continua a NON toccare le posizioni, ed è una decisione: misura un **prezzo**, che può rientrare. File: `agents/agent43-guardian.js` + `lib/maker/guardian-perdite.js`. |

**⚠ OGGI NESSUN PROCESSO SORVEGLIA IL BATTITO DI agent40**, ed è una conseguenza voluta della rimozione
di agent37 (§5 punto 63), non un difetto scoperto dopo: **agent37 guardava i processi, agent43 guarda il
capitale** — due guasti indipendenti, quindi due processi, e ne è rimasto uno. Se agent40 si blocca con
ordini a riposo, a toglierli restano la **GTD nativa** del venue (`lib/maker/order-ttl.js`) e, sul lato
economico, agent43 se la perdita supera la soglia.

**Fuori da pm2, a richiesta — `node scripts/monitor-reti-dei-21.js`** (`--watch`, `--json`): confronta il
board reward corrente con il **Setting Consensus** misurato sui 21 wallet vincenti
(`data/manuale-operativo-maker-v2.md`) — scadenza mediana 0,44 g, nozionale ~$34, size 77 share, un tick
dal mid, chiusura via redeem (94%). **Non filtra sul montepremi** (il campione dice che la banda non è un
criterio) e una scadenza non leggibile **non** entra fra i coerenti. Sola lettura dimostrata da un test
che cammina l'albero dei `require`.

---

## 4 · STATO ATTUALE DEL SISTEMA

**Ogni numero qui sotto è letto dal codice/stato reali** (per cosa fa il bot, v. §1).

### 4.1 · Il motore di piazzamento — `lib/maker/motore-unico.js`

Un profilo solo (Safe/Risk aboliti: la formula del venue è una curva continua e non conosce bucket;
nessun `if (profilo)` nel repo). **Le cinque regole, nell'ordine in cui si applicano:**

1. **Mai primo sul book** — vincolo assoluto, slegato dal punteggio. Se «un tick dietro il migliore» e
   «dentro la banda» si contraddicono, **vince la banda**: ci si ferma al suo bordo e il verdetto porta
   `onTop:true` perché il caso sia visibile. `top-of-book.othersLadder` sottrae i nostri ordini, o il
   motore inseguirebbe se stesso fino al bordo.
   **Due sole eccezioni**, entrambe omissioni puntuali del flag `inCoda` su UNA gamba, entrambe
   condizionate, e un test ne conta **esattamente due**: la controparte quando la banda sta **sotto il
   carico** (§5 p.59-60) e la gamba contraria del rimasuglio da chiudere (§5 p.66).
2. **Depth floor adattivo** — `DEPTH_FLOOR_PCT_OF_AVG = 0,10` della liquidità altrui media in banda di
   quel mercato specifico, non un dollaro fisso. Ripiego $15 per i mercati senza storico.
3. **Poi ci si ferma** — conseguenza del quadratico: soddisfatte 1 e 2 il livello trovato è già quello
   col punteggio più alto. Non esiste un controllo separato di volatilità o spread.
4. **Lato singolo deciso dalla formula, non da un timer** — dentro `[0,10 · 0,90]` un lato solo matura
   comunque un terzo e si tiene; fuori matura **zero** e si cancella subito. Il mid si rilegge a ogni ciclo.
5. **Tetto di capitale per mercato** — vedi 4.2. È gestione del rischio, deliberatamente fuori dal
   calcolo del punteggio.

**Soli sul lato ⇒ bordo ESTERNO della banda** (modo `fallback-alone-bordo-esterno`): senza concorrenti
si è primi per forza, quindi l'obiettivo è stare al prezzo **peggiore che resta premiante** — il fill è
improbabile e il reward matura comunque. Banda senza prezzi validi ⇒ **non si quota**. Appena compare
un concorrente si torna a un tick dietro.

**⚠ IL BORDO NUDO NON SI USA PIÙ: c'è un MARGINE, ed è adattivo** (§5-bis p.164).
`distanza-obiettivo.bordiConMargine` rientra il bersaglio di **`max(1 tick, 0,22 × v)`** dal bordo —
0,22 è **esattamente un tick sulla banda modale** (1,0¢ su 4,5¢), quindi il margine vale lo stesso
numero di centesimi su qualunque griglia; un margine misurato in **tick** sarebbe adattivo alla griglia
e non al mercato. **Due ragioni, e la seconda è quella che conta**: ① al bordo il punteggio è ~zero per
costruzione (`S = ((v−s)/v)²`, misurato **0,0123 al bordo contro 0,1111 un tick dentro**); ② il margine è
la **soglia bassa di uno Schmitt trigger** — si esce dalla banda a `v + hysteresisTicks` e si **rientra**
a `v − margine`, così non esiste più uno stato in cui un solo tick di mid rimette l'ordine fuori.
**⚠ Il margine non può mai avvicinare al mid oltre il prezzo di coda**: è applicato come `Math.min` col
prezzo che «mai primo sul libro» ha già scelto, e quando cede il fatto è dichiarato (`margineCeduto`).
Bordi che si incrociano (banda più stretta del doppio margine) ⇒ margine **non applicato** e dichiarato.
**⚠ E IL MARGINE SI FERMA A METÀ BANDA** (`FRAZIONE_MASSIMA_DEL_RAGGIO = 0,5`, costante di sorgente,
**nessun env**): oltre `v/2` l'ordine starebbe nella metà **interna** della banda, cioè più vicino al mid
che al bordo — chi ha chiesto il bordo esterno otterrebbe il contrario. Il tetto può portare il margine
a **zero** su una banda più stretta di due tick, e allora il bordo torna nudo: è la risposta onesta.

**Fine scala**: sotto 3¢ o sopra 97¢ un mercato sta risolvendo e non si quota (`end-of-scale.js`,
soglie da `.env` rilette a ogni chiamata; un valore che non si capisce viene **scartato** in favore del
difetto — un `.env` sbagliato non può spegnere una protezione). La chiamano quattro moduli.

**Mid stantio**: oltre **120 s** di cecità l'ordine si **cancella** (`mid-stantio.js`, env con clamp
`[5 s, 120 s]`). ⚠ A 20 s cancellava ciò che `decideReprice` non era disposto a riprezzare prima di 60 s,
cioè distruggeva ordini che nessuno stava per correggere. L'orologio si azzera **solo su una lettura
buona**, e una cancellazione fallita NON lo azzera. Tre cause distinte in audit —
`cecita-timeout-{mid-stantio|nessun-libro|eta-ignota}` — perché l'azione è la stessa ma la diagnosi no.

**Cadenza di reprice adattiva per mercato** (`cadenza-adattiva.js`): l'escursione del mid su 15 minuti
si traduce in tick/ora e da lì in tre classi — veloce 1 s, media 5 s, lenta 10 s. Chiamate al venue
−37,9%. **Non abbassa nessuna soglia**: `minMoveCents`, `hysteresisTicks`, `confirmSamples` e
`minIntervalMs` restano dov'erano, e guardare più spesso non riprezza di più. Misura assente ⇒ cadenza
di difetto. La decisione è guidata anche dall'**istante dell'ultimo book**, così un mercato «lento» col
book appena cambiato non aspetta dieci secondi.

### 4.1-bis · Il riprezzo guarda il BOOK, non solo il mid — R4, 18 agosto 2026

> **IL TRIGGER 3 VEDE SOLO IL CASO ESTREMO** («siamo diventati i primi del nostro lato»): la
> degradazione **PARZIALE** — un taker mangia tre livelli su cinque, il mid non si muove, davanti resta
> qualcuno ma molto meno — non la vedeva nessuno, ed è il momento in cui il rischio di essere riempiti
> sale proprio mentre il prezzo sta per muoversi contro. **IL TRIGGER 4** (`auto-reprice.js:681`) chiama
> `book-erosion`, che esisteva ed era cablato **solo** in un motore senza mercati configurati.
>
> | cosa | valore | dove |
> |---|---|---|
> | criterio | **solo erosione RELATIVA**: < 40% della baseline, 2 letture, isteresi 40/60 sulla baseline **congelata** | `book-erosion.updateErosion` |
> | buttato | **«è sparito un livello»** — 1.690 scatti su 1.775 venivano da lì, e su un feed troncato a **3 livelli** quel conteggio è rumore | — |
> | freno | **60 s** (non i 30 di difetto): è il rail del venue, 40 invii/60 s | `sospensione-erosione.FRENO_MS`, **iniettato** |
> | lato | **SELL esclusi**, come il TRIGGER 3 | `o.side !== 'SELL'` |
> | azione | **cancella e resta fuori**, tetto **5 minuti**, poi rientra e lo **dichiara** | `sospensione-erosione.js` |
>
> **⚠ NON PRODUCE MAI UN PREZZO**: può solo cancellare. Banda, «mai primo», tetti e scala d'urgenza
> restano identici — monotono, si aggiunge una cancellazione e mai un ordine.
> **⚠ SENZA IL REGISTRO SU DISCO LA REGOLA NON ESISTEREBBE**: a cancellare è agent40, a rimettere la
> gamba è agent41 (`ripristinaGamba`), la cui scala parte **subito** — «fuori 5 minuti» sarebbe durato
> due. **⚠ SE LA SOSPENSIONE NON SI SCRIVE, NON SI CANCELLA**: uscire e rientrare subito paga il costo
> (perdita della priorità di coda) senza comprare la protezione.
> **⚠ FAIL-APERTO, contro la regola generale del repo**: registro illeggibile ⇒ nessuna sospensione ⇒ la
> gamba torna a libro. Una sospensione è un'**astensione dal premio**, e un file che non si legge non
> deve poter tenere il bot fuori dal libro per sempre.
> **LA MISURA (17 agosto, 50 mercati, 34.478 campioni)**: 97 episodi · mediana **5,44 min/giorno** per
> mercato, peggiore 30,87 · premio perso **$0,025/giorno sui tre attivi** · **66 episodi su 97 finiscono
> per TETTO**, cioè il libro **non si ricostruisce in 5 minuti**. ⚠ I 97 sono un **limite inferiore**
> (il feed campiona molto più lentamente di agent40). ⚠ Vedi §5.2 p.43 per ciò che resta aperto.

### 4.2 · I tetti di capitale — `lib/rewards/concentration.js`, UNA fonte, importata

**Nessun numero cablato: il tetto DERIVA da `f_min`.**

```
tetto per mercato = pavimentoPremiante(SCAGLIONE_FINANZIABILE) = 50 × 0,98 × 1,25   = $61,25
                    ⇒ f_min NON è più l'ingresso: è la conseguenza, e vale 0,32
tetto per ordine  = tetto × 0,97 / 0,98 + $5                                         = $65,63
pavimento premiante(minSize) = minSize × 0,98 × 1,25   ⇒ 20/50/100/200 = $24,50/$61,25/$122,50/$245
tetto EFFETTIVO per ordine = min(safety.maxOrderNotionalUsd $80, $65,63)             = $65,63
```

**⚠ IL TETTO PER ORDINE NON È «METÀ DEL MERCATO»** (§5-bis p.164): `tetto/2 + $5` è la gamba giusta
**solo a mid 0,49**, mentre su un mercato sbilanciato la gamba cara vale fino al
`PREZZO_MASSIMO_QUOTABILE = 0,97` del costo della coppia — cioè il **99%** del capitale del mercato. Era
la **causa a monte misurata di `coppia-non-atomica`**, la prima causa di perdita di gambe. Il tetto è
dimensionato sulla **gamba peggiore quotabile**, non sulla media, e per conseguenza derivata (non
ricopiata) la **finestra di mid** è `[0,01 · 0,99]`, cioè smette di essere un cancello.

- **Il numero di mercati è una CONSEGUENZA** (`capitale ÷ tetto`), non un parametro: quando il capitale
  cresce si spalma su **più mercati**, non si ingrossa la size su ciascuno. Una frazione pura
  (`tetto = C×k`) fa esattamente l'opposto ed è stata scritta e buttata (§5 p.107).
- `capPerMarketUsd(capitale)` **non restituisce mai `null`** (a valle varrebbe «nessun tetto», cioè
  fail-open) e può solo **stringere**: si clampa al capitale.
- **Undici consumatori lo IMPORTANO**, nessuno lo ridichiara: pianificatore/knapsack, motore (Regola 5),
  `decideRimpiazzo`, punteggio di rischio, adapter, corsia manuale, … `netto-centralizzato.test.js`
  verifica gli import **per nome**, e il rilevatore **D1** dell'audit sorveglia `MARKET_CAP_FIXED_USD`.
- **Un mercato sotto il pavimento premiante NON si quota**: sotto `min_incentive_size` il reward è
  **ZERO**, non più basso. Meglio meno mercati sopra soglia che tanti sotto.
- **⚠ Il tetto NON si può alzare per diversificare** (§5 p.117): a `f_min` 0,32 i mercati passabili
  **CALANO**, perché `Q` cresce col tetto mentre il margine di $5 resta fisso e la finestra di mid si
  stringe. La leva è più capitale, non una manopola.

> **🔓 IL TETTO DI ESPOSIZIONE NON PUÒ MURARE UNA GAMBA NUDA — §5-bis p.168.** `evaluateLimits` limite 2
> confronta `openNotionalUsd + notional > cap`, che è l'aritmetica di uno che APRE: su uno che CHIUDE è
> sbagliata **di segno** e murava sia il **BUY** che completa la coppia sia la **SELL** che liquida la
> gamba nuda. Terza occorrenza della classe «regola nata per limitare l'APERTURA applicata a un'azione
> che non apre».
> **⚠ NON È UNA DICHIARAZIONE DI CUI FIDARSI**: l'esenzione arriva già **provata** da
> `esenzione-chiusura.provaChiusura` — la **stessa** funzione del tetto per ordine, importata e non
> ricopiata, calcolata una volta sola per ordine. SELL entro il posseduto, BUY entro `manca`, letti dallo
> snapshot del venue; qualunque lettura mancante lascia il tetto applicato. Si guarda `=== true`, mai la
> truthiness.
> **⚠ ESENTA QUESTO TETTO E BASTA**: tetto per ordine, rate limit, perdita giornaliera, posizioni
> illeggibili, esposizione non misurabile, allowlist e KILL restano davanti e **identici** (sei
> asserzioni). L'esenzione **si dichiara** nell'audit (`outcome: 'esenzione-esposizione-chiusura'`) e
> **non** si dichiara quando il tetto non stava mordendo, o il conteggio di domani sarebbe sporco.

**Tetto di ordini per finestra** (`data/safety-risk-limits.json`): **40 invii / 60 s**, con **quota
60/40** — al più 24 posti alle aperture, **16 riservati a rinnovi e chiusure protettive**. Invariante
difesa da un test: `rateCap ≥ 2 × mercatiPerGiro` con almeno 8 posti di margine. Un'apertura rimandata
è un **rinvio dichiarato** (`rimandato-per-quota`), non un errore.

**I numeri correnti**: cap per ordine di safety **$80** · cap cumulativo di esposizione aperta
**$1.300** (dal 22 agosto 2026, decisione dell'operatore, per reggere i **10 mercati** di §4.13: conta i
**fill riconciliati**, non gli ordini a riposo) · **perdita giornaliera massima $100**, che è **il freno
vero** — il tetto di esposizione serve solo a non murare la gestione · **mercati per giro 10**,
dichiarati in **un posto solo** (`utilizzo-capitale.leggiMaxNuoviPerGiro`) e importati dal trigger.
**⚠⚠ IL CAP NON È UN PERMESSO, È UN BUDGET**: `realloc-cycle.js:242` fa
`capitale = min(saldo, maxOpenNotionalUsd)` **prima** del knapsack, quindi alzarlo è un **ordine di
allocare di più**, non l'autorizzazione a farlo se capita. A $1.494,78 di saldo il cap passa dal **43%
all'87%** del capitale: da limite che morde a limite quasi inerte, e la difesa effettiva si riduce al
**kill R10** e al **guardiano**.
**⚠ Il cap non si abbassa «perché morda»**: il gate confronta `openNotionalUsd + notional` **anche sugli
ordini di APERTURA**, quindi un cap stretto smette di piazzare a metà strada — successo davvero a $150 il
16 agosto. L'invariante giusta è **`cap ≥ esposizione massima raggiungibile`** = N coppie a riposo
**più** il loro completamento (§5.2 p.37), definita in un punto solo
(`concentration.esposizioneMassimaRaggiungibileUsd(N)`).
**⚠ Il presupposto del $1.300 è §5.2 p.54 CHIUSA**: col guardiano vecchio l'artefatto di co-temporalità a
10 mercati a size piena valeva **$72,46** contro un margine di $75,08 e la coppia di letture del 20/08
**avrebbe fatto scattare** il guardiano; col nuovo vale **$14,74** (**5,1× di franco**). Chi riporta
indietro il guardiano deve riportare indietro anche questo numero.
**⚠ `data/safety-risk-limits.json` NON È GITIGNORED**: i cinque numeri che governano l'esposizione
vivevano solo sul disco di una macchina, e un ripristino da git li avrebbe riportati a valori diversi
**in silenzio**. **Una fonte sola versionata**, non default-nel-repo + override-locale.
`limiti-versionati.test.js` fallisce se il file manca, se torna in `.gitignore`, se manca un limite, se
un valore supera il tetto duro, e — l'asserzione che conta — **se il disco non coincide con il
versionato**. Il lettore falliva già chiuso: `clampNum` marca `missing`, `HARD_CEILINGS` taglia solo
dall'alto, `manual-order` rifiuta con `cap-missing`.

**⚠ La quota 60/40 sui volumi di oggi non morde mai** e va saputo: 141 intent in 48 h, picco 18/min
aperture contro 24 posti. Il gate del rate limit del **venue** ha morso **una volta in 48 ore**. E
`skip-rate-limited` in `auto-reprice` **non è** il rate limit del venue: è `minIntervalMs`, l'intervallo
anti-churn **locale** di 30 s, che per costruzione non può costare un ordine (margine di rinnovo 180 s).
La causa vera per cui un rinnovo muore è `motore-non-conforme` — il rimpiazzo non sarebbe stato un
ordine valido, e il motore ha ragione a non piazzarlo.

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

| filtro | dove | regola |
|---|---|---|
| **orizzonte** | `horizon.js` | `[MIN_HORIZON_DAYS **0,50** · MAX_HORIZON_DAYS 150]`, confini **inclusivi da entrambi i lati**. Il pavimento in ore (**12 h**) è **derivato** in `market-validity` e in `risk-classifier`, non ripetuto. Il confine di rischio misurato è a **6 ore** (sotto, il 35,1% delle uscite arriva dopo la risoluzione; fra 6-12 h è 0/36), quindi a 12 h restano **due volte** il margine; **0,25 g è sconsigliato**. **Scadenza non determinabile ⇒ ESCLUDE**. ⚠ **È il filtro che taglia di più** (78 mercati su 102 valutati), e il gradino è tutto fra 12 h e 18 h — vedi §5 punto 129 prima di toccarlo o di lasciarlo com'è |
| **quota coda lunga** | `allocator.js` | il capitale oltre `LONG_TAIL_DAYS 7` non supera il **12%** del piano. **Due passate**, non una potatura: la fascia corta gira col budget pieno, la coda riceve `S·q/(1−q)` — non `S·q`, che sbaglierebbe in difetto perché la quota è sul totale e il totale contiene la coda. Fascia corta vuota ⇒ la coda non ottiene niente |
| **profondità** | `profondita-minima.js` | **scala la size**, non toglie il mercato: `S_max = cQ · q/(1−q)` a `q = 0,60`, cioè `1,5 · cQ`. Esclude solo dove **nessuna size piazzabile** regge, con due motivi distinti (`escluso-troppo-sottile` / `escluso-sotto-minimo`). ⚠ **VINCOLO ASSOLUTO: mai forzare la size al minimo del venue oltre la quota sicura** — è strutturale (i due rami di esclusione restituiscono `tenuti` senza toccarlo), non promesso |
| **quotabilità** | `allocator.js` | chiama `planBehindBest`, **la stessa funzione del piazzamento**, su **entrambi** i lati (una riga con una gamba sola è esposizione direzionale). Fail-open: dati mancanti ⇒ `ignota`, il mercato resta. «Nessun concorrente» **non** è un dato mancante: è il ramo «soli», quotabilissimo |
| **tetto di credibilità** | `realistic-estimate` | `maxCredibleShare = 0,60`, applicato per **LIVELLO** della curva: aggiungere capitale a un mercato sottile smette di aiutare oltre il tetto. È la concavità che alla selezione mancava. Una definizione sola, importata da entrambe le parti |
| **book vuoto verificato** | `allocator.js` | `capVuotiFrac = 0,30` del lordo pesato. Uno **0 misurato** (≥10 campioni ws su book fresco) non è un buco: un dato mancante è `null` e **non diventa mai zero**; sul non verificato l'obiettivo **si astiene** |
| **peso di posizione** | `allocator.js` | il lordo è pesato col punteggio alla distanza **reale**, non al ceiling: su banda 4,5¢ un tick vale 2,79× fra tick grosso e fine. Acceso **solo** nel pianificatore |

**`ignota` non esclude mai** — vale per profondità, quotabilità e (fino al filtro d'orizzonte) scadenza.

**Una sola formula capitale→share**: `lib/rewards/size-da-capitale.js`, `Q = C/(p_yes+p_no)`. **Il mid
non decide più chi qualifica**: `capitalToQualifyUsd(0, 20)` e `capitalToQualifyUsd(0.9, 20)` danno lo
stesso numero. Il ripiego senza costo della coppia usa il tipico **0,98** e lo **dichiara**
(`modello: 'ripiego-tipico'`), mai la vecchia `(C/2)/mid` — che a mid 0,055 sbagliava di nove volte.

**⚠ Il tetto è un SOFFITTO, non l'allocazione**: la griglia può fermarsi sotto, e allora il `f_min`
reale del piano è più alto dell'obiettivo. Con la griglia di 4.3 le righe arrivano al tetto e `f_min`
torna ≈ 0,61.

### 4.5 · Il capitale al lavoro — `utilizzo-capitale.js` + `capitale-al-lavoro.js`

```
totale   = saldo + posizioni          ← e NIENTE altro
libero   = max(0, saldo − ordiniARiposo)
alLavoro = totale − libero            ← DERIVATO per differenza, mai risommato
obiettivo = 0,95      (leggiTarget, unica fonte)
```

Un BUY a riposo **non abbassa il saldo** su questo venue: l'ordine è firmato off-chain e il collaterale
resta nel wallet fino al match. Quindi `ordiniARiposo` è un **sottoinsieme** di `saldo + posizioni`, mai
un addendo — sommarlo è il doppio conteggio del 9 agosto (+16,1%, §5 p.58), che oltre a mentire
**allargava un limite di rischio**. `misuraDopo` **non accetta più il saldo come parametro**: l'errore
non è più esprimibile. `riconcilia()` ferma il giro (`fermato-capitale-incoerente`) se due letture del
saldo divergono oltre **max(2%, $5)** — relativa perché su conti grandi $2 non sono niente, assoluta
perché su conti piccoli il 2% è rumore. **Una lettura mancante non è una lettura concorde**, ma nemmeno
una divergenza: non si confronta e si prosegue col saldo del trigger.

**Non misurabile non è zero**, mai: un saldo illeggibile trattato come 0 direbbe «utilizzo 100%» proprio
quando il capitale è fermo. Sotto l'**80% per 30 minuti** si scrive la **ripartizione del fermo in
dollari**, attribuita **da monte a valle** (piano senza righe → non quotabili → tetto pieno → quota →
rifiuti del venue) così lo stesso dollaro non è contato due volte, e ciò che nessuno ha misurato resta
**`non attribuito`: una voce, non un arrotondamento nascosto**. Si vede su
`GET /api/maker/utilizzo-capitale`, nel giornale (`op: capitale-al-lavoro`) e a ogni ciclo di agent41.

### 4.6 · Il ciclo di vita di una posizione

**Fill ⇒ modalità chiusura** (`modalita-chiusura.js`): timestamp scritto una volta sola e persistito, le
share non fillate **spariscono in ogni caso**, poi **PIANO A** — il taker immediato, che è il Livello 1
e non un secondo meccanismo — e **solo se fallisce** le regole di chiusura. Parziale e totale sono lo
**stesso percorso**: la ramificazione è nei dati (`residuiDaCancellare` guarda il libro), non in un `if`.

**⚠ FILL PARZIALE: IL RESIDUO SI CANCELLA SEMPRE E SUBITO** (17 agosto 2026, decisione dell'operatore).
Il residuo dell'ordine che ha prodotto il fill esce dal libro **a ogni giro** finché è là, non solo al
primo e non solo quando la coppia si completa. La guardia è **«il registro della modalità chiusura è
cablato»**: senza `deps.chiusura` il comportamento resta quello di prima. Esito
`modalita-chiusura-residuo-non-fillato-cancellato`, con `alPrimoGiro` a dire quando. **⚠ Si perde** che
il residuo si riempia da solo completando la coppia senza pagare lo spread; si evita una posizione
direzionale che cresce mentre la scala d'uscita la riduce. **Le liste non sono ricopiate**: filtrano
l'unica di `modalita-chiusura.residuiDaCancellare`.

**La gerarchia del merge, senza scorciatoie.** `completaCoppia` è chiamata da **tutti** i rami di
`runAutoCloseCycle` — `already-covered`, `close-at-market`, uscita ordinaria e **`skip`** — tranne i tre
in cui manca un ingresso (`no-position`, `no-entry-price`, `rules-unreadable`), che lo **dichiarano**
(`merge-saltato-senza-ingressi`) invece di tacere.

| # | stadio | tetto |
|---|---|---|
| 0 | **merge on-chain** se la coppia è già completa | rende **$1/share subito**, gas del relayer, zero slippage |
| 1 | Livello 1 — taker sull'altro lato | coppia ≤ **101¢** |
| 2 | Livello 2 — maker a riposo, attesa **30 min**, **bersaglio su disco**; ai cicli dopo si **aggiunge** la differenza, mai si sostituisce l'ordine vivo (aprirebbe una finestra di scoperto totale) | coppia ≤ 101¢ |
| 3 | chiusura rapida: taker fin dove il book copre + limit per il resto | coppia ≤ **101¢** |
| 4 | riposizionamento scoperto: SELL a **+1% dal carico**, dentro banda e **mai sotto il carico**, + BUY sulla controparte | coppia ≤ 101¢ |

> **📐 IL PAVIMENTO DELLA SCALA DEV'ESSERE UN PREZZO ESPRIMIBILE — 22 agosto 2026.**
> `pavimentoConcesso` è una frazione del carico (il 5%, R7) e non cade quasi mai su un tick:
> `0,68 × 0,95 = 0,646`, `0,37 × 0,95 = 0,3515`. `auto-close.inseguiIlBid` lo usa come `Math.max`,
> quindi appena il bid scende sotto il pavimento il **prezzo dell'ordine diventa il pavimento**, e il
> guard condiviso lo rifiuta con **`OFF_TICK`**. Misurato sul giornale vivo: **147 righe** con
> `OFF_TICK` — **25** `skip-guard-refused` a 0,646 su `0x4757745c` (22/08 17:47→18:14), **107** e **15**
> `skip-remainder-below-min-size` con codici `OFF_TICK,BELOW_MIN_SIZE` su `0xac3ee338` e `0x70620889`
> (20-21/08, carico 0,37), dove la deroga sul minimo del venue **non si applica proprio perché** c'è
> anche OFF_TICK.
> **LA CURA**: `pavimentoConcesso` restituisce **due numeri** — `pavimento` (esatto, serve a
> **confrontare**) e `pavimentoGriglia` (sulla griglia del mercato, serve a **prezzare**).
> **⚠ UN SOLO ARROTONDAMENTO IN TUTTO IL REPO**, e sta lì: nato dentro il solo ramo fuori banda era
> metà della correzione, e la metà che non serviva ai 132 rifiuti veri. `exit-plan` **legge**
> `pav.pavimentoGriglia`, non lo ricalcola — un test conta gli arrotondamenti e pretende che sia **uno**.
> **⚠ IN SU, E LA DIREZIONE È OBBLIGATA**: in giù si venderebbe **sotto** il pavimento della scala del
> §7. In su se ne concede **meno**: il tappo del 5% non si sposta, può solo stringersi sulla griglia.
> **⚠ IL CONFRONTO RESTA SUL NUMERO ESATTO**: spostarlo cambierebbe chi passa e chi no (il ramo
> «pareggio non basta»), che è una decisione di rischio e non un arrotondamento. Le due cose non
> possono contraddirsi: `b.hi` sta già sulla griglia, quindi `b.hi ≥ pavimento ⇒ b.hi ≥ pavimentoGriglia`
> — l'arrotondamento **non può** spingere il prezzo fuori banda. Asserito su 500+ piani, non promesso.
> **⚠ VALE ANCHE SENZA CONCESSIONE**: il pavimento a gradino 0/1 **è il carico**, che è un prezzo
> **medio di fill** e cade fuori griglia più spesso di una frazione (0,6733 non è un prezzo).
> **⚠ SU UN TOKEN ECONOMICO IL PAVIMENTO PUÒ FINIRE SOPRA IL CARICO** (0,095 ⇒ 0,09025 ⇒ **0,10**): è la
> conseguenza onesta di una griglia da 1¢ su 9,5¢ — `tickConcessi` diceva già **0**. Prima quel caso
> produceva un rifiuto, adesso un ordine valido.

> **🚪 L'USCITA PUÒ GUARDARE FUORI BANDA QUANDO LA COPPIA È IMPOSSIBILE — 22 agosto 2026,
> decisione dell'operatore.** `exit-plan.planExit` sapeva produrre **solo** prezzi dentro la banda
> premiante: il clamp porta il prezzo a `b.hi`, e se `b.hi` sta sotto il pavimento della scala il
> verdetto è `no-target`, cioè **nessuna uscita** — il miglior bid del libro non veniva nemmeno
> guardato. Misurato su MrBeast `0x4757745c`: bordo alto banda **0,55**, pavimento concesso **0,646**,
> miglior bid **0,64** — fuori banda ma **9¢ meglio** di qualunque prezzo in banda.
> **LA REGOLA**: gamba scoperta **e** coppia economicamente impossibile (`carico + ask sorella` oltre
> il tetto di **101¢**) ⇒ l'uscita considera anche prezzi **FUORI** dalla banda. Prezzo =
> `max(pavimento del gradino, min(obiettivo, miglior bid))` — la **stessa** aritmetica di
> `inseguiIlBid`, non una seconda. Si rinuncia al premio su quella gamba per non restare direzionali.
> **⚠ IL MERGE VIENE PRIMA, SEMPRE, ED È SCRITTO**: `sizeAltroLato > 0` ⇒ si fonde e non si vende. La
> precedenza esisteva per struttura (`provaCoppia` gira prima in ogni ramo); adesso è **una
> condizione**, e `sizeAltroLato` **non letta** chiude la deroga.
> **⚠ IL TAPPO DEL 5% (R7) E LA SCALA DI §7 NON SI TOCCANO**: il pavimento è un `Math.max`, quindi
> questo ramo può solo scegliere un prezzo che la scala **già consentiva**. Se il pavimento resta sopra
> il bid, l'ordine sta a riposo fuori banda e non si riempie — **è la risposta voluta**.
> **⚠ IL PAVIMENTO SI ARROTONDA IN SU SULLA GRIGLIA, e la direzione è obbligata**: `pavimentoConcesso`
> è una frazione del carico (0,68 × 0,95 = **0,646**) e non cade su un tick. In giù concederebbe **più**
> perdita; in su ne concede **meno**. Il pavimento che esce dal piano è quello arrotondato, o
> `inseguiIlBid` a valle lo riporterebbe fuori griglia.
> **⚠ IL TRIGGER DI BANDA NON GIUDICA UN'USCITA FUORI BANDA VOLUTA**: `band-exit` chiude **a mercato**,
> cioè vende al bid, che starebbe **sotto** il pavimento — sarebbe un modo di aggirare il pavimento del
> rischio. `decideExit({fuoriBandaVoluta:true})` non valuta il trigger 1 e lo dichiara; **il tetto di
> attesa (24 h) resta intatto**, ed è l'unica via d'uscita che non passa dal pavimento.
> **⚠ E NON DICHIARA `inCoda`**: `manual-order` **riassegna** `price = q.price` dopo `prezzo-in-coda`,
> e quel ricalcolo riporterebbe l'uscita **dentro** banda, annullando in silenzio il prezzo scelto. È la
> **quarta** omissione condizionata di `inCoda` in `auto-close`, contata per nome da
> `risposta-al-fill.test.js`. «Mai primo sul libro» non è toccata: su un SELL non rifiuta mai.
> **⚠ IL PREMIO PERSO È ZERO PER COSTRUZIONE**, non per misura: un'uscita fuori banda **resta a
> riposo** solo dove `b.hi < pavimento`, cioè dove **nessuna uscita in banda era ammessa** e quindi non
> c'era nessun ordine da cui maturare. Quando il bid arriva al prezzo scelto l'ordine **attraversa** e
> si riempie: non riposa. Asserito su 7.000+ stati in `uscita-fuori-banda.test.js` ⑥.
> **⚠ MONOTONO E OPT-IN**: senza `uscitaFuoriBanda: true` `planExit` è la funzione di prima riga per
> riga (asserito su 273 combinazioni); la deroga non abbassa mai un'uscita né la fa sparire.
> **Fail-closed** su ogni ingresso: bid illeggibile, ask dell'altro lato illeggibile, coppia non
> misurabile, `sizeAltroLato` non letta ⇒ nessuna deroga.

**⚠ IL LIVELLO 0 SI VALUTA PRIMA DI QUALUNQUE GUARDIA SUL PREZZO** (R8): le due guardie che aprivano
`decidiLivello` — carico non leggibile, tetto non calcolabile — parlano del prezzo a cui si comprerebbe
il **secondo lato**, e rispondevano anche a una coppia **già completa**. Il conto di `manca` sta
**sopra** le due guardie; chi **compra** pretende ancora carico e tetto, identici. Monotono: si tolgono
due rifiuti, non si aggiunge un acquisto.

**Un obbligo di esito** si apre nella stessa istruzione che scrive la decisione e va chiuso: due punti di
flush che nessun `continue` può saltare, e `merge-esito-mancante` per chi sfugge. **Ogni** esito di
`registraCoppia` scrive una riga, `non-applicabile` e `in-attesa` compresi.

**Tetto della coppia 101¢, e adesso è UNO SOLO** (decisione dell'operatore; prima erano 99¢ per il merge
e 120¢ per la chiusura rapida). La misura sui 65 maker veri: costo mediano di una coppia completata
**100,00¢**, solo il **41,2%** chiude entro 99¢, e la valvola 110-120¢ la usa il **2,7%** — a 99¢ si
rifiutava la maggioranza delle uscite che il mercato offre davvero. `MERGE_MIN_MARGIN_CENTS` è
**derivato** (`100 − 101 = −1`), non ricopiato; `MAKER_TETTO_COPPIA_CENTS` è un env con clamp
`[100 · 200]`. Il valore si asserisce in **un punto solo**; gli altri test lo **derivano**.

> **💰 LA PRESA DI PROFITTO DECIDE SUL BID CAMMINATO, MAI SUL MID — §5-bis p.169.**
> `lib/maker/presa-di-profitto.js` (puro), chiamata da `decideClose` **dopo** le guardie su mercato
> chiuso e **prima** di `already-covered`. **Il criterio non ha costanti arbitrarie**: incassare al bid
> batte completare la coppia esattamente quando `bid + ask > 1`. Due rami — **`coppia-battuta`** (coppia
> disponibile: scatta se `bid + ask > 1 + m`) e **`coppia-bloccata`** (coppia oltre il tetto di 101¢:
> scatta se `bid > carico + m`, perché l'unica alternativa è la scala d'urgenza, che sa solo scendere).
> `MARGINE_CENTS = 1`, **centesimi per share e non tick**.
> **SI ATTRAVERSA, NON SI INSEGUE**: il prezzo è il bid camminato — restare sopra il bid ricrea il
> difetto misurato (283 campioni su 354 minuti, **ZERO istanti offrivano un'uscita in guadagno**: il
> «guadagno» del pannello era la differenza fra il mid e il bid, e un take-profit ancorato al mid
> esisteva già e non ha mai incassato niente). **TUTTA LA SIZE O NIENTE**: una copertura parziale
> lascerebbe un residuo sotto il minimo, cioè capitale senza via d'uscita. `TETTO_COPPIA_CENTS`
> **importato**. **⚠ Fail-closed**: ask illeggibile, scala che non copre la size, carico illeggibile ⇒
> non scatta. **⚠ Il ramo `close-at-market` NON chiama `provaCoppia` quando il trigger è la presa di
> profitto**, e l'obbligo di esito viene scaricato a mano.

**⚠ E LA SCALA DEVE ARRIVARE AL PREZZO, non al permesso** (§5-bis p.138). `already-covered` **ricalcola**
il prezzo a ogni giro e, dal gradino 1 in su, l'uscita **insegue il miglior ask** fermandosi al pavimento
— la scala dice quanto si può perdere, il book dove si viene presi, **vince il più stretto**. Riduce e
basta (solo se il prezzo nuovo è più basso di un tick). **`planExit` produce un PAVIMENTO, non un
prezzo**: chi lo tratta come prezzo lascia l'uscita sopra il book e non scende mai.

**La resa dopo 60 minuti** (`urgenza-scoperto.js`): gradino 1 a **30 min** (uscita fino al carico),
gradino 2 a **60 min** ⇒ chiusura **peggiorativa**, gradino 3 a 240 min ⇒ anomalia grave.
**⚠ LA CONCESSIONE È IL 5% DEL CARICO, E BASTA** (R7, 18 agosto 2026, decisione dell'operatore; era
`max(daTick, daFrazione)`, che sui token cari non raggiungeva mai il 5%). **⚠ ALLARGA UN LIMITE DI
RISCHIO**: caso peggiore **$3,06** (5% della gamba più grande apribile) contro $0,63 di un tick.
**⚠ `concessioneTick` è il CANCELLO, non la quantità**: dice se il gradino 2 è stato raggiunto, e
`Infinity` resta fail-closed. **⚠ Sui token economici non cambia niente**: a 9,5¢ il 5% resta più stretto
di un tick e sulla griglia la concessione si azzera — la gamba resta in attesa invece di essere svenduta.

**La regola generale del lato scoperto** vale da **qualunque causa** (fill, residuo di merge parziale,
chiusura rapida incompleta) e converge in **un punto solo** — l'esito `rinuncia` di `completaCoppia`.
Sotto il minimo del venue la quantità si **accumula** in `data/residui-scoperti.json` per mercato/lato:
**ultima osservazione + storia, MAI somma aritmetica** — la size che arriva è `sizePosseduta`, cioè la
posizione al venue, **già cumulativa**: sommare tre fill darebbe 120 invece di 65. *(Il registro della
**sorella** somma invece, ed è giusto: lì ogni voce è un ordine NOSTRO, cioè un incremento vero. Le due
regole sono opposte perché le due fonti lo sono.)* **Il minimo è del venue e per MERCATO** (20/50/100/200),
non una costante nostra.

**Chiusura forzata a 3 ore** dalla risoluzione: il verdetto si calcola **prima** della guardia sui
livelli (il livello 3 è l'esito più comune) e l'esecuzione resta **dopo** le cancellazioni. La scadenza
si legge da **board ∪ catalogo di ripiego ∪ venue**. Una coppia **completa** non si forza: alla
risoluzione vale $1 comunque.

**Le chiusure sono esenti dal tetto per ordine**, e l'esenzione è una **prova rifatta sull'ordine
esatto** contro lo snapshot posizioni: SELL ≤ share possedute, BUY ≤ `manca`. Un BUY così può solo
**appaiare** — nel caso limite porta i due lati in parti uguali, cioè esposizione direzionale **zero**.
Qualunque lettura mancante lascia il tetto applicato, e **il tetto di safety non è mai esentato**.
**Una sola aritmetica per due cinture** (`prova-riduzione.js`, importato dal GATE 4 e dall'adapter):
ricopiarla sarebbe il reperto D1, e qui una divergenza allargherebbe un limite di rischio.

**I percorsi taker non mirano ai propri ordini**: passano da `othersLadder`, la stessa funzione di «mai
primo sul libro». La self-trade prevention del CLOB non è documentata, quindi non ci si conta.

**Gamba orfana**: al rinnovo GTD si chiede «la posizione che giustificava quest'ordine esiste ancora?».
Una gamba sola + zero posizioni ⇒ si **cancella** invece di rinnovare, e il mercato torna da
ripianificare. **Conferma in due osservazioni** (60 s): la prima **arma soltanto**, così la corsa del
fill non può produrre una cancellazione sbagliata. Il discriminante è l'**asimmetria**, non lo zero:
zero posizioni + **due** gambe è lo stato SANO di una coppia appena piazzata.

**Riprezzo atomico**: `replaceManualOrder` (cancella→ripiazza) ha **cinque** precontrolli prima
della cancellazione — kill, orologio del mercato, guard condiviso sul prezzo, **tetto per ordine**,
**chiave di idempotenza** — tutti con `oldCancelled:false`, così si lascia l'ordine dov'è e il ciclo
dopo riprova. **Nessuna costante nuova**: tetto e chiave vengono dalle stesse funzioni del GATE 4 del
piazzamento. I tre percorsi di cancellazione **voluta** (mai-primo, mid stantio, fine vita) non passano
di qui e sono intatti.

**Piazzamento di coppia atomico in PRECONTROLLO**: si valutano **entrambe** le gambe con
`evaluateManualCapGate` — la stessa funzione che poi rifiuterebbe, e lo stesso `caps` — prima di
inviarne una. Una fuori ⇒ **zero invii**, `gate: coppia-non-atomica`. **Si precontrolla ciò che si può
sapere prima, si ripristina ciò che si scopre dopo**: banda, mai-primo e minimo premiante dipendono dal
libro all'istante del piazzamento, e leggerlo qui vorrebbe dire due letture che possono divergere.
Le **chiusure sono esenti per costruzione**: il precontrollo vive dentro `if (accoppiato)` e una riga di
uscita è un gruppo di una.

### 4.7 · Scoperta e feed

**agent24** ogni **15 minuti esatti**: dorme il *resto* del periodo (`SCAN_INTERVAL_MS − durata`, con un
pavimento di 60 s) e **cronometra** la fase di profondità, dichiarando a ogni scansione il tetto che
starebbe nel periodo a quel ritmo. **`REWARD_MAX_CLOB_MARKETS = 300` dal 21 agosto 2026** (era 150), e
il numero viene dal cronometro: i libri si prendono in **blocco** (`POST /books`,
`lib/rewards/libri-batch`) ⇒ **1,40-2,47 s/mercato** ⇒ 300 mercati in **7,0-12,4 min**, dentro il
periodo anche al ritmo peggiore; **400 sforerebbe**.
⚠ **IL COLLO NON SONO I LIBRI, È `MAX_RPS = 1.5`**: la coda `httpGet` è SERIALIZZATA, quindi le sei
chiamate per mercato che sembrano parallele scorrono a 667 ms l'una, mentre un `GET /book` costa 24-152
ms. Chi vuole andare oltre 300 deve guardare `MAX_RPS` e le altre quattro chiamate per mercato
(`prices-history` ×2, `tick-size`, `markets/<cid>`), non il batch.
⚠ **UN LIBRO CHE MANCA ESCLUDE IL MERCATO, RUMOROSAMENTE**: un `status !== 200` restituiva
`emptyBook:true, Qmin:0`, cioè **concorrenza zero**, cioè la quota stimata MASSIMA — un mercato non
letto si presentava come il **migliore del board**. `analizzaLibro` distingue `assente` da `emptyBook` e
il ciclo salta il mercato dichiarandolo. `ETA_BOARD_MAX_MS = 25 min` sta sopra il periodo ma sotto il
doppio, così una scansione saltata per intero resta visibile.
**⚠ Il costo di una scansione si stima sugli elementi che PROCESSA, non su quelli che sopravvivono ai
filtri a valle** (fra i due numeri c'era un fattore **3,5**, e bastò a fermare il capitale), e quando un
numero governa una finestra temporale si tara su un **cronometro**, non su un'aritmetica.

**La scadenza ha una fonte sola: il venue**, col board come riscontro. Il CLOB **tronca a mezzanotte
UTC**, quindi è per costruzione mai più tardi di Gamma — la più prudente, e il registro di chi smette
davvero di accettare ordini. Divergenza > 24 h, o Gamma prima del CLOB > 1 h ⇒ mercato **escluso a
monte** (`scadenza-discorde`); una lettura **mancante** invece non esclude — le due direzioni di
fallimento sono opposte apposta. **Quando il troncamento è DIMOSTRABILE**
(`troncaAMezzanotteUTC(gamma) === clob`) si usa l'ora vera di Gamma
(`gamma-ora-vera-su-clob-troncato`): è una **prova**, non tre indizi.

**Il feed di agent34 non è un anello chiuso**: `allocator` scarta i mercati a profondità
`non-verificata` e la verifica accetta **solo** campioni websocket, ma il websocket sottoscriveva
`collector-priority.json`, che agent41 scriveva **dal proprio piano**. Il feed si semina anche con i
**CANDIDATI** (minSize compatibile col tetto *di adesso*, letto dal capitale vero, + orizzonte ≥ 18 h) e
con i mercati con **posizione aperta**. Tetto della corsia **60**. Ordine di sacrificio: righe del piano
→ quasi-vincitori → trattenuti → **candidati per primi** (un candidato è un'ipotesi, una riga del piano
è capitale deciso). Board illeggibile ⇒ zero candidati. ⚠ È la corsia che oggi limita davvero cosa entra
in piano: §5.2 p.55.

### 4.8 · La regola di copertura, applicata in SEI punti

«**Board ∪ mercati dove il capitale è già esposto**, mai solo il board.» **Una** definizione
(`auto-reprice-config.liveMinMarketIds`), sei consumatori: gate live-min · sottoscrizione del book ·
composizione del board (`rewards-normalize`) · lista dell'uscita automatica · scope del rinnovo ·
catalogo di ripiego. **Non allarga il perimetro di rischio**: aggiunge solo mercati dove il capitale è
**già** dentro — non apre un mercato nuovo, apre la *gestione* di una posizione che esiste.
Fail-closed ovunque, e subordinata all'interruttore generale.

**L'unione ha TRE componenti**: `abilitati ∪ posizioni ∪ mercati con ORDINI A RIPOSO` — la terza da
`lib/safety/venue-orders-snapshot.js` (`enabledDaOrdini`), e la stessa entra nello `scopeRinnovo` di
`auto-reprice`. Senza di essa, il 18 agosto un mercato uscito dal board dieci minuti dopo aver ricevuto
due ordini veri ($56,36) è rimasto **senza nessuno che rinnovasse**, e la GTD è scaduta: bot armato e
fuori dal libro per 52 minuti.
**⚠ QUESTO SNAPSHOT FONDE PER MERCATO, NON SI SOVRASCRIVE**, ed è lì che sta la regola: le posizioni
arrivano da una chiamata che elenca tutto, quindi «assente» è una **prova**; gli ordini si leggono **un
mercato per volta e solo per i mercati in scope**, quindi «assente da questo giro» quasi sempre
significa «non ho guardato». Lo scrittore riceve `guardati` **e** `conOrdini`: non guardato ⇒ la voce
resta, guardato e vuoto ⇒ la voce esce.
**⚠ Una memoria di processo non basta**: `deps.mercatiConOrdiniVivi` si sovrascrive intera a ogni giro,
si popola solo dopo quattro cancelli, e `cadenza-adattiva` fa `continue` **prima** del conteggio — un
giro saltato per cadenza cancellava il mercato, che quindi non veniva più guardato.
**⚠ LA VALVOLA PER-VOCE È UN BACKSTOP A 6 ORE, NON UN MECCANISMO**: la via d'uscita normale è
l'osservazione. A 30 minuti «perché sopra la GTD» riprodurrebbe il guasto con un'ora di ritardo.

> **⚲ IL PERNO `MAKER_LIVE_MIN_MARKET` RESTRINGE, NON AGGIUNGE — decisione dell'operatore.**
> `perno impostato ⇒ il perimetro live-min È il perno, e nient'altro`; perno assente ⇒ è la lista
> dell'operatore. **Perché**: «un mercato solo» non era esprimibile — **l'unione non si può svuotare
> finché una posizione esiste** (misurato: svuotando la allowlist il perimetro restava 2, non 1 né 0).
> **⚠ È MONOTONO PER COSTRUZIONE** (`{perno} ⊆ {perno} ∪ lista`), provato **esaustivamente su 80
> combinazioni**: non esiste configurazione in cui faccia passare un ordine che prima non passava.
> **⚠ CIÒ CHE SOSPENDE, e va saputo prima di armare**: con un perno attivo un mercato con posizione
> **non riceve più il BUY di completamento coppia**. Può ancora essere **USCITO** (l'eccezione di
> riduzione è valutata *prima* dei rifiuti e passa dal token, non dal mercato). Chi vuole quel BUY toglie
> il perno; non c'è una terza via.
> **⚠ UNA SOLA ARITMETICA**: `adapter.perimetroLiveMin`, importata dal gate, dal pannello
> (`manual-order`) e da `scripts/cli/mercati.js` — erano tre copie e divergevano già, sbagliando nella
> direzione che rassicura. **⚠ IL PERNO VIVE NEL PROCESSO**: si legge da `/proc/<pid>/environ`, non dal
> `.env`, e cambiarlo richiede il riavvio **dal file** e **insieme** (§5.1).

**⚠ E due filtri con lo STESSO predicato in fila sono una trappola** (§5 p.55): la soppressione per
profondità viveva in agent24 *e* in `buildCombined`, e l'eccezione «un mercato con capitale dentro non
sparisce» era scritta solo sulla seconda — la riga non arrivava mai fin lì. **Quando si esenta qualcosa
da un filtro, la domanda non è «l'eccezione è scritta?» ma «la riga arriva fin qui?».**
`punti-di-filtro.test.js` tiene la tabella dei sedici punti di filtro sui mercati.

### 4.9 · Merge on-chain e relayer

`CTF_RELAYER_ENABLED = **true**` (costante di sorgente, **non** una env: due interruttori per una
decisione sola significano che spegnerne uno non la spegne). **Solo `mergePosition` ha un chiamante**:
`auto-close.fondiCoppia`, raggiunta quando `decidiLivello` risponde `azione:'merge'` (`mancaAllaCoppia
<= 0`). `splitPosition` e `redeemPosition` restano **esportate e mai invocate**.

Il confine non si allarga: `verificaConfinamento()` ri-decodifica il batch prima della firma e rifiuta
qualunque target che non sia uno dei due adapter CTF. Il firmatario è **lo stesso wallet** della corsia
manuale, e il controllo di coerenza chiave↔credenziali vive **in un punto solo**, dentro il relayer.
Fail-closed: `negRisk` non booleano, size non finita, flag spento o qualunque eccezione ⇒ **non è
successo niente**, e si prosegue col comportamento di prima.

**Perché lo split non conviene MAI in questa strategia** (§5 p.48): lo split rende 1 YES + 1 NO per
**$1,00** esatti, mentre comprare le due gambe in banda costa **0,93-0,999** (mediana 0,97 su 37 coppie
reali) — quel 3% di sconto **è** il margine, perché la coppia costa `1 − 2·offset` per costruzione. E
soprattutto **lo split non mette niente sul libro**: due token fermi non maturano nulla, cioè non costa
3¢ in più, **rinuncia all'intero ricavo**. Se la coppia costasse ≥ $1 il bot **non aprirebbe** quella
posizione: lo sconto *è* la condizione d'ingresso.

**Nessun confronto di convenienza fra merge e vendita**, ed è stato scritto e buttato: il merge rende
$1/coppia **subito**, senza slippage e senza gas; la vendita rende `bid × size` su **un lato solo**,
lascia l'altro in portafoglio (quindi non chiude la posizione, la rende direzionale) e attraversa lo
spread. Un confronto con un termine sempre maggiore può solo sbagliare. **Coppia completa ⇒ merge.**

Trappola operativa: il relayer rifiuta le deadline corte (`400 deadline too soon`) — `DEADLINE_SEC = 900`.

### 4.10 · Registri, giornali, persistenza

`data/polymarket-maker-audit.jsonl` cresce di **67-82 MB/giorno** e **ruota sopra i 400 MB**,
portandosi nel file nuovo gli ultimi **64 MB** allineati a un a capo (~20 h): senza passato recente
`origine-ordine` dichiarerebbe ogni ordine «ignoto» e il reset si piazzerebbe **sopra i propri ordini**.
Ordine: lucchetto → ri-`stat` → `rename` → append della coda; fra rename e append una riga può finire
fuori ordine, **mai persa**. **Gli archivi non si cancellano, non si potano, non scadono.**
⚠ La rotazione **non si innesca sotto un `*.test.js`** (guardia su `argv[1]`): una rotazione innescata da
un test è un'azione di produzione che nessuno ha chiesto.

I giornali si leggono in modo **incrementale** (`giornale-incrementale.js`): `readFileSync(…,'utf8')`
costruisce UNA stringa e V8 si ferma a ~512 MB. Rileva la rotazione da **inode + dimensione + testa** (un
file riscritto in place passerebbe i primi due) e consegna anche l'ultima riga senza `\n` — cioè il
record **più recente** — senza consumarla. ⚠ Chi legge una finestra grande legga anche §5-bis p.201: il
lettore del backtest va usato con `scartaCampi`, o il figlio del piano va in OOM.

**Persistono su disco** (provato con `kill -9` su nove processi): attese di merge · modalità chiusura
col bersaglio della sorella · residui scoperti e sotto soglia · tetti · gestione manuale · allowlist ·
catalogo di ripiego · idempotenza · confronto reward · baseline e latch del guardiano · piano
dell'allocatore · `da-ripianificare.json`. **Nessun buco strutturale.** In memoria e perso *senza costo*:
contatori di conferma del riprezzo, insiemi anti-ripetizione dei log, cache posizioni 5 s, registro orfani.

**Origine di un ordine**: campo `origine` **accanto** a `source` (`source` dice quale corsia piazza,
`origine` dice se dietro c'era una persona). Il reset di agent41 cancella **solo** ciò che è
provatamente `auto`; manuale e **ignoto** restano sul libro. Terza origine **`auto-chiusura`**, che il
reset non tocca **per decisione**. Le costanti sono **importate**, non ricopiate — era una stringa
ricopiata a produrre il difetto delle 4.686 righe etichettate male.

**Idempotenza**: chiave deterministica sull'identità economica
(`sha256(userId|venue|tokenId|side|price|size)`), **nessuna componente temporale**. Un piazzamento che
supera un ordine **morto** riceve una chiave derivata dall'id di quello che supera; la **catena** di
sostituzioni arriva a **20.000** anelli. **La protezione anti-doppio-invio non è il tetto**: è la
verifica che l'ordine precedente sia morto sul venue, e vale a **ogni singolo anello**.

**La riconciliazione dei fill confronta grandezze OMOGENEE**: il volume del venue per **token+lato**
contro quanto è già registrato per **token+lato** su tutte le chiavi (e per **id-ordine-venue** nel ramo
`size_matched`), mai contro una singola `idempotencyKey` — altrimenti ogni ripiazzamento sulla stessa
gamba ritrova lo stesso volume e lo registra **intero** come fill proprio (§5 p.72: 2.790 share fantasma
contro **zero** al venue, bot bloccato dal tetto per un errore di somma).

**Il ledger si netta contro il venue**: uno snapshot `readable` che non elenca un token è **prova** che
quella posizione è chiusa (oltre `MAX_AGE_MS` `readable` è già `false`, e su questo venue la risposta è
l'elenco completo). Assente, vecchio o illeggibile ⇒ **non si netta niente**. **Nessuna riga viene
cancellata**: il ledger resta append-only e la posizione resta marcata `chiusaAlVenue` con la sua
`esposizionePrimaUsd`.

**`skipped` non sparisce dal referto**: non entra né in `placed` né in `refused`, quindi «0 piazzati, 0
rifiutati» descriveva un **blocco totale** con la stessa riga con cui descriverebbe l'inazione. Il
referto porta `saltati` e `motiviSaltati`.

### 4.11 · Backoff, rate limit, resilienza

429 ≠ 5xx: il 429 parte da 1 s e raddoppia (1→2→4), e **`Retry-After` vince** su qualunque progressione
(secondi o data HTTP, max 30 s). Dopo un esito **ambiguo** — la POST era partita — non si ritenta alla
cieca: si interroga il venue, e se l'ordine c'è l'esito è **riuscito**; una verifica che non riesce vale
«non ritentare», perché fra due ordini e zero ordini il secondo errore costa meno.

`/positions` ha **5 tentativi, 1 s → 30 s, con jitter ±25%**: senza jitter ogni lettore riparte dallo
stesso istante dopo lo stesso 429, ed è il modo di rendere permanente un rate-limit. Un 200 con un corpo
che non è una lista **non si ritenta**. **⚠ La soglia dei 180 s sullo snapshot NON è toccata**: è la
protezione che impedisce di piazzare su una fotografia vecchia delle posizioni.

I **sei piazzamenti di chiusura** riprovano fino a **3 volte** (`piazzaChiudendo`), ma **solo** se a
rifiutare è il venue — un `gate` nostro non cambia fra un tentativo e l'altro — e **mai su un esito
ambiguo**. Il KILL si rilegge **prima di ogni ritentativo**. **La quotazione ordinaria non riprova**: un
ordine di liquidità può aspettare il ciclo dopo, una posizione scoperta no.

**pm2**: `min_uptime: 30 s` + `max_restarts: 500` sui processi critici, in **un punto solo** del config
(`RIAVVIO_ROBUSTO` + `PROCESSI_CRITICI`); `restart_delay` resta **per-agente** (6 valori distinti:
appiattirli sarebbe una regressione travestita da uniformità). ⚠ La politica diventa effettiva solo con
`pm2 restart agents/ecosystem.config.js --only <nome>`.

### 4.12 · Stima e consuntivo

**La stima è una QUANTITÀ, non un tasso fotografato**: `Σ(tasso × durata)`, campionata ogni **5 minuti**
da agent40 con **orologio e lucchetto propri**. Tre regole: un campione vale al più **due passi**, uno
scoperto **sottostima e lo dichiara** (`coperturaFrazione`), un tasso non finito **non si registra**.

**Il consuntivo è per GIORNO, non per mercato**: sulle righe REWARD `conditionId`, `title` e `slug` sono
vuoti (il venue paga un bonifico aggregato), e il totale **non viene diviso in proporzione** — sarebbe un
numero inventato con l'aspetto di una misura. Fonte: registro attività **pubblico** keyed sul **funder**
(le credenziali L2 sono dell'EOA: era un problema di **identità**, non di endpoint). Recupero **a
ritroso** fino a 30 giorni, perché i tentativi notturni cadono prima che il pagamento arrivi. Visibile su
`GET /api/maker/registro-reward`.

### 4.13 · La selezione automatica dei mercati — `lib/maker/selezione-mercati.js` (15 agosto 2026)

La lista dei mercati quotabili la riempie il bot, dentro i vincoli dell'operatore. **La decisione è
PURA** (zero `require`, un test lo asserisce); il cablaggio sta in `agent41` e passa dalle **stesse**
funzioni di prima — `preparaMercatoNuovo` per chi entra, `rilasciaDallaSelezione` → `setAutoReprice`
per chi esce. *(Storia delle stesure precedenti: `docs/storia-per-sezione.md`.)*

| | |
|---|---|
| **vincoli** | `rewardsMinSize ≤ 50` · **scadenza ≥ 24 h** e **≤ `MAX_HORIZON_DAYS`** · **niente famiglia meteo** · **max N ATTIVI dove N = `MAKER_MERCATI_CONTEMPORANEI`** (R1: ambiente di agent41, un posto solo, letto da `/proc`; **soffitto e difetto 10 dal 22/08** — il difetto E' il soffitto, `quanti-mercati.js` lo importa) · **book UTILIZZABILE** (v. riquadro) · **composizione DERIVATA da N** (`quotaScaglioni`): N≥2 ⇒ 1 «basso» (≤20) + (N−1) «alto» (≤50); N=1 ⇒ un secchio solo, che ammette tutto |
| **interruttore** | `data/selezione-mercati.json`, `scripts/cli/selezione.js {stato\|prova\|accendi\|spegni}`. Difetto **SPENTA**; file illeggibile ⇒ **spenta**. **ACCESA dal 15/08** |
| **quando gira** | a ogni ciclo 6 h **e** a ogni controllo del capitale fermo (120 s), **prima** del piano — e prima di `decidiTrigger`, così un mercato che scade esce anche nei giri in cui il trigger non scatta |
| **classifica** | `levels[<capitale minimo>].grossRewardDay`, cioè la stima che **il board ha già calcolato** con la formula del venue → ripiego `rateOrdinamento` → `rewardsDailyRate`. **Non** il montepremi. Pareggio rotto sul `conditionId`: due giri sullo stesso board danno la stessa risposta |
| **il piano si restringe** | `restringiAllaSelezione` in `calcolaPianoFuoriProcesso`, cioè il punto per cui **entrambi** i percorsi (6 h e mini-ciclo) sono coperti da una regola sola. **Interseca, non sostituisce**; intersezione vuota ⇒ vincolo **impossibile**, mai vincolo **assente** |

⚠ **Il vincolo delle 3 CATEGORIE è stato TOLTO** (15/08): la diversificazione teneva due slot sui
mercati **peggiori** (netto −$0,111/g e +$0,026/g contro +$10,64/g escluso). ⚠ **168 → 24 h**: fra 48 e
168 h il board è VUOTO. ⚠ **Il filtro meteo toglie righe davvero solo da quando l'orizzonte è 24 h**
(prima ne toglieva zero, le aveva già tolte la scadenza): una regola che vale «per conseguenza» va
scritta esplicitamente, perché la conseguenza cambia e la regola no.

> **📖 IL BOOK DEV'ESSERE UTILIZZABILE.** Il cancello chiede «il book memorizzato è utilizzabile?»,
> **non** «ha avuto eventi di recente»: escluso solo chi ha **`needsResnapshot === true`** o non ha
> proprio un book. **Nessuna soglia di età, di nessun tipo.**
> **⚠ Escludere `live !== true` buttava fuori i mercati TRANQUILLI** — `live` significa «è arrivato un
> evento su QUEL asset negli ultimi 30 s», e su un libro fermo il quadro memorizzato resta perfetto
> (misurato: al picco di 35 s coincideva **esattamente** con la lettura REST). E i mercati tranquilli
> sono quelli che un maker di rewards vuole. Col criterio vecchio erano esclusi **14 book su 125**, col
> nuovo **1**. **⚠ LA DOMANDA «SIAMO CIECHI?» NON APPARTIENE ALLA SELEZIONE**: la risolve `mid-stantio`
> (§4.1), che decide se TOGLIERE un ordine già a libro — due soglie sullo stesso fatto sarebbero due
> opinioni. **⚠ UNO SLOT VUOTO PER SCARSITÀ SI DICHIARA** (`slotVuotiPerScarsita`, `postiNonAssegnati`,
> `scartatiPerComposizione`): è spesso povertà del board, non un difetto, e le due cose devono restare
> distinguibili.

> **🧊 «SLOT STERILE» — LA REGOLA C'È MA È DISARMATA** (`SLOT_STERILE_ARMATO=0`). Libererebbe uno slot
> che per **due osservazioni consecutive** non produce ordini. **⚠ Disarmata la sera stessa in cui è
> nata**: presumeva che la causa stesse nel MERCATO mentre stava nel FEED, e ha buttato fuori **cinque
> volte** un mercato che andava benissimo. **⚠ La correzione c'è e non è mai girata armata**: «nessun
> ordine a libro» ha **due cause opposte** — *sterile* e *svuotato da noi* (mid stantio, erosione) —
> quindi un'osservazione non conta come sterile se in quel mercato ci sono state **cancellazioni
> nostre** nella finestra, e il contatore si **azzera a ogni piazzamento riuscito**. **⚠ Disarmata non
> vuol dire assente**: misura e scrive cosa *avrebbe* fatto. **Per riarmarla**: si cancella
> `SLOT_STERILE_ARMATO` da `ecosystem.config.js` e si riavvia agent41 **dal file**. Assente ⇒ **ARMATA**,
> come `SBLOCCO_GRADINO6_ARMATO`.

> **🔄 LA ROTAZIONE ROVESCIA LA REGOLA DELLO SLOT — decisione dell'operatore, 16 agosto 2026.**
> Un mercato che riceve un fill — **totale o parziale** — **esce dal conteggio degli N attivi** e **resta
> in gestione** fino a coppia chiusa o mollata; contemporaneamente ne entra uno nuovo, al pavimento
> premiante, rispettando composizione e scaglioni. Stato: `inGestione` + `inGestioneDal`; giornale:
> `entratiInGestione`, `liberati`.
> **⚠ LA CONSEGUENZA VA DETTA PER INTERO: L'ESPOSIZIONE TOTALE NON È LIMITATA DAL NUMERO DI SLOT.** N
> quotano mentre altri completano. Ciò che la limita è, in ordine: il **tetto per mercato** ($61,25), il
> cap cumulativo di esposizione aperta (**$1.300**, §4.2) e il **kill a −$100**. Chi rialza uno di quei
> tre alza il rischio di questa regola, non di quella.
> **⚠ UN MERCATO IN GESTIONE DEVE RESTARE ABILITATO AL RIPREZZO**: `restringiAllaSelezione` usa
> `idsAttivi` (solo i non-in-gestione) per il **piano**, ma la lista del riprezzo tiene **tutti** gli id.
> Toglierlo farebbe morire la gamba sorella per GTD in ≤ 23 min, cioè **prima** dei 30 che la scala le
> concede.
> **⚠ USCIRE DALLA LISTA SPEGNE L'INGRESSO, NON L'USCITA**: `rilasciaDallaSelezione` tocca
> `setAutoReprice` e **niente altro** — la posizione resta gestita da §4.8. Due test lo verificano per
> assenza.
> **⚠ FAIL-CLOSED NEI DUE VERSI**: board o posizioni illeggibili ⇒ nessuna decisione e **nessuno esce**;
> ma una **singola** scadenza non determinabile **esclude quel mercato**, come in §4.4.
> **⚠ NON ACCENDE NIENTE**: servono ancora, indipendentemente, l'interruttore del riprezzo, AVVIA, il
> KILL spento e `MANUAL_ORDER_PLACEMENT` (§4.14). Decide **su quali** mercati, mai **se**.
> **⚠ Ordina e spodesta col NETTO del knapsack** (iniettato), con **isteresi `max($0,50/g, 25%)`**: non
> spodesta chi ha ordini vivi o una gamba in attesa — salvo netto occupante negativo e sfidante positivo.
> **⚠ UNO SCAGLIONE VUOTO NON SI RIEMPIE COL VICINO**: il posto resta **non assegnato e dichiarato**
> invece di essere preso da un «alto» — sostituire cambierebbe in silenzio la cifra di capitale che
> l'operatore ha deciso.

> **🔁 LA COPERTURA CONTINUA RIMETTE LA GAMBA A LIBRO — §5-bis p.171.**
> **⚠ IL NUMERO CHE GOVERNA IL DISEGNO È 720**: il ciclo che ospita la decisione gira ogni **120 s**, e
> senza raffreddamento un mercato che rifiuta sempre verrebbe ritentato 720 volte al giorno.
> `lib/maker/ripristino-gambe.js` (puro) è una scala sui fallimenti **consecutivi**: subito · 5 · 10 · 20
> · **30 min di tetto**, azzerata quando il mercato torna `coperto`. Il primo tentativo è immediato
> perché la GTD è 23 min; il tetto sta **sopra** la GTD perché oltre quella soglia il problema non è più
> «manca la gamba» ma «questo mercato non si riesce a quotare», e la risposta è `da-sostituire`.
> **Contenimento provato coi numeri: 50 tentativi su 720 cicli, fattore 14,4×** — asserzione del test,
> non una frase in un commento. **⚠ Si azzera su `coperto` OSSERVATO, non su un invio accettato.**
> **LE TRE COSE CHE NON FA**: ① non è una seconda strada verso il venue — riga dal piano **già salvato**
> → `gambeDiUnaRiga` → `piazzaCoppia`, cioè lo stesso `runBulkAllocation` con lo stesso freno e gli
> stessi gate; ② **non ricostruisce il piano**; ③ **non abilita niente**. **E UNA CHE FA**: scrive
> **sempre** a verbale (`tipo: 'ripristino-gamba'`), anche quando non tenta — un presidio che non lascia
> traccia non è verificabile.
> **⚠ SI PIAZZA UNA GAMBA SOLA DI PROPOSITO, e non contraddice §4.6**: l'altra gamba **è già a libro** —
> è la definizione di `da-coprire` — e il precontrollo atomico vive dentro `if (accoppiato)`.
> **⚠ Trappola**: `gambeDiUnaRiga` produce righe con `book` e **senza `tokenId`** mentre
> `valutaCopertura` risponde in **token** (serve una traduzione esplicita, fail-closed), e `LOCK.stato()`
> restituisce **`id`**, non `conditionId`.

> **⚖ IL RIPRISTINO RICOSTRUISCE LA COPPIA, NON LA GAMBA — decisione dell'operatore.**
> `gambeDiUnaRiga` calcola `Q = capitale/(p_yes+p_no)`, cioè simmetrica **nell'istante in cui
> costruisce**, mentre la gamba superstite porta la size dell'istante in cui *fu piazzata*: la stessa
> formula a due istanti diversi, e **nessuno riportava la viva a oggi** (87,5 + 62,2 share ⇒ $67,17
> contro un tetto di $61,25). **La causa era l'ASIMMETRIA, non il tetto.** La cura
> (`lib/maker/coppia-simmetrica.js`, puro, zero `require`): una size per **entrambe**,
> `Q = min(Q_piano, Q_tetto, Q_gamba_viva)`, e nessuno dei tre può far CRESCERE niente.
> **⚠ `Q_gamba_viva` LA RENDE MONOTONA**: far crescere un ordine a riposo per «pareggiare» sarebbe
> aggiungere esposizione per ragioni di simmetria, e la simmetria si ottiene anche scendendo.
> **⚠ `Q_tetto` usa i prezzi VERI di ciò che resterà a libro**, e il tetto iniettato è
> `MARKET_CAP_FIXED_USD`, non `capPerMarketUsd`: qui non si pianifica, si dimostra che il gate non
> rifiuterà — e il gate confronta la costante.
> **⚠ SOTTO IL MINIMO PREMIANTE NON SI RICOSTRUISCE, e il tetto NON si allarga**: unico esito in cui il
> modulo dice «no» invece di «più piccolo».
> **⚠ L'ORDINE DELLE DUE AZIONI È PARTE DELLA CURA**: `nozionale-mercato-oltre-tetto` somma il nozionale
> a riposo ⇒ **prima si riduce, poi si piazza**; se la riduzione fallisce **non si piazza**, perché due
> gambe asimmetriche sono peggio di una sola. Il lucchetto copre entrambe le azioni, e **il prezzo della
> gamba viva non si tocca**. **⚠ LE DUE LETTURE DEVONO CONCORDARE**: lati diversi fra `v.mancanti` e gli
> ordini vivi ⇒ una delle due è vecchia ⇒ **nessuna azione**; gli ordini vivi si **passano**, non si
> rileggono. A verbale finiscono `coppia` (size, vincolo, totale, i tre `Q`) e `ridotte`.

**Il terzo meccanismo che può spegnere un mercato.** Gli altri due sono `setTracking` (ciclo 6 h) e
`impostaBot` (fermo di sicurezza). `trigger-capitale-fermo.test.js` pretende che **ogni `enabled: false`
del file appartenga a un meccanismo dichiarato**. Il pattern **non** è stato allargato a un
`setAutoReprice(` generico — sarebbe un varco largo quanto il file.

**Due trappole di questo codice:** `\brain\b` senza ancore classifica come meteo **«Ukraine signs peace
deal with Russia before 2027?»** («rain» sta dentro «Ukraine») — due mercati geopolitici sparivano in
silenzio. E `Number(riga.rewardsMinSize)` su un campo assente vale **0**, cioè `0 ≤ 20`: un mercato di
cui non si sa il pavimento premiante veniva dichiarato **il più finanziabile di tutti** (§5.3).

### 4.14 · Le QUATTRO cinture, e mordono tutte e quattro

> **LE CINTURE DELL'OPERATORE SONO QUATTRO E MORDONO TUTTE**, sulla strada da cui il bot piazza davvero
> (§5-bis p.191). La quinta, `MAKER_PLACEMENT`, è stata **tolta** e non disarmata: era un ripiego
> sull'ambiente **senza chiamanti** — *«una cintura senza chiamanti è peggio di nessuna, perché me la fa
> contare»*. ⚠ Toglierla **STRINGE**: senza ripiego, un chiamante che non passa `placement` ottiene
> `dry-run`, che è la posizione chiusa.
>
> | cintura | dove morde | gate |
> |---|---|---|
> | `MAKER_MODE` | `evaluatePlacementGate`, via `buildPlacementAdapter` | `maker-mode` |
> | `MAKER_ADAPTER_DRYRUN` | idem | `dry-run` |
> | `MANUAL_ORDER_PLACEMENT` | l'ultimo `if` prima della POST (`adapter.js:923`) | nessuno: `dry-run-validated` |
> | freno di agent41 | `giro()` e `controlloCapitaleFermo` ⇒ `dryRunOnly` alla corsia in blocco | nessuno: non si invia |
>
> **⚠ Le prime due vengono da `lib/maker/cinture-armamento`**, cioè dallo **stesso modulo da cui
> `stato.js` le racconta**: non uno specchio da confrontare ma **la** lettura, usata per dire lo stato e
> per deciderlo — il reperto D1 qui non è esprimibile. (Prima `buildPlacementAdapter` cablava
> `mode:'live-min'` e non passava `dryRun`, e l'adapter fa `dryRun = opts.dryRun === true`: erano inerti.)
> **⚠ MONOTONO PER COSTRUZIONE**: modo non vivo ⇒ `off`, ombra ⇒ rifiuto; nessuna configurazione che
> prima rifiutava ora passa. Ambiente illeggibile ⇒ entrambe scattano.
> **⚠ NON TOCCA LETTURE NÉ CANCELLAZIONI**: `buildPlacementAdapter` ha **un solo chiamante**, e leggere e
> cancellare passano dall'adapter cancel-only, che non ha né modo né `dryRun`. Il guardiano cancella.
> **⚠ `puoPiazzare` resta «le quattro sono aperte», non «l'ordine passerebbe»**: davanti restano `kill`,
> `venue-allowlist`, `limit-*`, `v2-sdk-*`, `funding-approval`, che sono stato del sistema.
> **LA PROVA**: `node scripts/ricerca/prova-cinture.js` — **10 verdi, 0 rossi**: ognuna inserita **da
> sola** con le altre tre aperte ⇒ zero ordini al venue simulato col gate atteso, più il **CONTROLLO**
> (quattro aperte ⇒ l'ordine parte), senza il quale quattro rifiuti non proverebbero niente.
> ⚠ Un banco che cabla modo/`dryRun`/`placement` ignorando gli `opts` è **più permissivo del venue
> proprio sulle cinture**: il seam dev'essere solo la rete.

---

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

> **Chiuse oggi, e scese a una riga** (diagnosi integrale in §5-bis e in `git log`):
> **p.15/16 guardiano k=2 + letture distinte** → §5-bis p.141 e p.145 · **p.17 registro residui senza
> consumatore** → p.148 · **p.18 tetto per ordine sul riposizionamento scoperto** → p.147 ·
> **p.21 «cancellazioni continue» = ciclo di riprezzo** → NO, misurato: vita mediana di un ordine
> **18,2 min**, `band-exit` è una VALUTAZIONE (3.622 giudizi «fuori banda», **zero** cancellazioni) e
> 3.898 dei 4.874 eventi sono macchina di CHIUSURA ·
> **p.39 il residuo su fill parziale** → CHIUSO il 17/08: si cancella SEMPRE e subito (§4.6), la
> condizione precedente era una tautologia e la guardia vera era «solo il primo giro» ·
> **p.28 i due commenti a 110¢ in `auto-close.js`** → corretti il 16/08 nello stesso commit che porta
> il tetto unico a 101¢ (§5-bis p.165), il reperto D7 non esiste più.

49. **✅ CHIUSA IL 21 AGOSTO** — la catena obiettivo/stima concorda al bit; `realistic-estimate.js:269`
   NON era solo display (ordina `scegliMercato` e alimenta `confrontoDiValore`), ma sul board vivo sposta
   **uno scambio adiacente su 29** e la prima scelta non cambia. Diagnosi integrale:
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
54. **✅ CHIUSA IL 22 AGOSTO** — la cura non è una tolleranza sui timestamp (misurata e scartata) ma la
   **conservazione del valore**: `Δcassa + Δsize ≈ 0`, o il totale non è misurabile. Regola viva in §3,
   diagnosi integrale in §5-bis p.204 e `docs/registro-voci-chiuse.md`.
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
57. **🟡 LA COMPOSIZIONE PER SCAGLIONE NON SCALA COL NUMERO DI SLOT — 22 agosto 2026, NON corretta.**
   `quotaScaglioni` dà **1 solo posto «basso»** (minSize ≤ 20) per qualunque N: a 12 slot sono
   1 + 11. Ma la fascia corta è **dominata dai minSize 20** — misurato sul board del 22/08: 4 dei
   7 corti ammissibili sono «basso» e si contendono **un posto solo**. È la ragione misurata per
   cui il quinto slot corto è restato vuoto per due cicli (`postiVuoti: [{corta:1}]`). ⚠ Cambiarla
   sposta la cifra di capitale per scaglione, che è una decisione dell'operatore (§4.13). **Non
   toccata.**
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
37. **✅ CHIUSA IL 19 AGOSTO** — l'invariante è **`cap ≥ esposizione massima raggiungibile`** (N coppie a
   riposo **più** il loro completamento), non `cap ≤ N × tetto per mercato`; definizione unica in
   `concentration.esposizioneMassimaRaggiungibileUsd(N)`. **⚠ Non si scende sotto**: un tetto che
   impedisce di CHIUDERE non è un limite di rischio, è un rischio. Diagnosi integrale:
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
- **L'hook di piazzamento blocca anche un ciclo di agent41 lanciato a mano**, e anche un heredoc di
  documentazione che *nomini* una funzione di piazzamento. **Non si aggira**: il comando lo esegue
  l'operatore, o si usa lo strumento di scrittura file invece di `cat <<EOF`.

---

## 5-bis · REGISTRO DELLE VOCI CHIUSE — **SPOSTATO IN `docs/registro-voci-chiuse.md`**

**A cosa serve.** Le decisioni vive stanno in §3 e §4; il registro serve a risolvere un riferimento
come «§5 punto 72» o «§5-bis p.204» sparso nei commenti del codice, e a sapere *che* un problema è
già stato incontrato. Il dettaglio integrale è in `git log` e nei commit citati nei sorgenti.

> 📄 **`docs/registro-voci-chiuse.md`** — verbatim, niente tolto: le voci **1-205** (titolo e
> diagnosi), le sezioni del 13 agosto, e il registro completo 1-119 numero per titolo.
> **Le ultime cinque, per orientarsi**: p.205 da 5 a 10 mercati e cap $1.300 · p.204 le due fonti del
> totale si riconciliano sul VALORE · p.203 vista board 150→300 · p.202 il riferimento del guardiano
> sale solo su conferma · p.201 l'OOM del figlio del piano.
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


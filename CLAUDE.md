# CLAUDE.md — contesto permanente del progetto

Questo file viene letto automaticamente all'avvio di ogni sessione Claude Code aperta da
`/root/rewards-bot`. **Il contesto vive qui, non nel prompt**: non serve più reincollarlo ogni volta.

Ultima verifica contro codice/stato reali: **7 agosto 2026**, ~21:35 UTC.

> **Attenzione, 7 agosto 2026:** durante la stesura di questo file era attiva **una seconda sessione
> Claude Code** sullo stesso repo (PID 1034803, avviata alle 19:33). Fra le 21:27 e le 21:29 ha
> avviato `agent42-guardian` in pm2 e toccato `.env`. Se leggi §3/§4 e qualcosa non torna, ricontrolla
> lo stato runtime: parte di ciò che è descritto qui si è mosso *mentre* veniva scritto.

---

## 1 · STACK E INFRASTRUTTURA

Bot di **liquidity rewards su Polymarket**: piazza ordini maker *fermi* dentro la banda premiante e
incassa i premi di liquidità del venue. I reward si pagano sugli ordini **a riposo**, non sui fill —
per un maker l'esecuzione è il costo, non il ricavo.

| | |
|---|---|
| Runtime | Next.js 14.2 (App Router) · Node v20.20.2 · TypeScript |
| DB | Prisma 5 → **PostgreSQL** (`DATABASE_URL` in `.env`) |
| Processi | **pm2**, 41 processi definiti in `agents/ecosystem.config.js`; **12 online**, gli altri deliberatamente fermi (commit `47ff87e`: «riduzione all'insieme minimo») |
| Server | Hetzner Helsinki, Ubuntu, `62.238.52.227` (verificato) |
| Path | Repo in `/root/rewards-bot`. **`/root/prediction-market` è un symlink allo stesso path** ed è il `cwd` dichiarato in pm2: i due nomi sono la stessa directory |
| Repo | GitHub privato `git@github.com:gasparatodiego-blip/prediction-market.git`, branch `main` |

**Capitale reale connesso.** Funder on-chain `0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee` (è un
*contratto* deposit-wallet ERC-1271, `MAKER_SIGNATURE_TYPE=3`; l'EOA firma e non detiene nulla).
Alla verifica del 7 agosto 2026: **pUSD $590,26 + 1 posizione ~$70,30 ≈ $660 totali**.

Il numero invecchia: **non citarlo a memoria, rileggilo** (lettura on-chain, sola lettura):

```bash
node -e "
const fs=require('fs');
for(const l of fs.readFileSync('.env','utf8').split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*\"?([^\"#]*?)\"?\s*\$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}
(async()=>{
  const {leggiSaldoUsd}=require('./lib/maker/saldo-cache');
  const {readVenuePositions}=require('./lib/safety/venue-positions-snapshot');
  const s=await leggiSaldoUsd(); const p=readVenuePositions();
  const v=(p&&p.positions||[]).reduce((a,x)=>a+(Number(x.size)*Number(x.curPrice)||0),0);
  console.log('saldo',s.usd,'affidabile',s.affidabile,'| posizioni',(p&&p.positions||[]).length,'valore',v.toFixed(2));
})();"
```

---

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
   - **(b) agent42-guardian** — cancellazioni automatiche in caso di perdita oltre soglia.
4. **`npm run build` in autonomia; il restart no** (vedi regola 2).
5. **Ogni modifica di codice va deployata subito sul bot live** — build + attivazione — non solo
   committata. Il deploy che richiede un restart pm2 si chiede (regola 2) e si esegue subito dopo.
6. **Commit e push su `main` per ogni modifica significativa**, salvo istruzione contraria.
7. **Verifica sempre a fondo prima di dichiarare concluso un lavoro.** Non fermarsi alla prima
   lettura superficiale: leggere il codice che decide davvero, non il commento che lo descrive, e
   controllare lo stato runtime (`pm2 env`, i file in `data/`) e non solo la configurazione.

### I tre interruttori, e chi decide cosa

| Interruttore | File / flag | Semantica |
|---|---|---|
| **AVVIA / FERMA** | `data/maker-bot-enabled.json` via `lib/maker/bot-enabled.js`, bottone in cima alla tab **Mercati ottimizzati** | Decide se il bot apre posizioni da solo. `agent41` lo rilegge **a ogni ciclo**: FERMA vale dal ciclo dopo, senza restart. File mancante/illeggibile/malformato ⇒ **fermo**. Ferma i piazzamenti *nuovi*, lascia gestite le posizioni aperte (auto-close, riprezzatura, rinnovi). |
| **KILL** | `data/safety-kill-switch.json`, `lib/safety/kill-switch`, `/api/maker/kill` | Emergenza assoluta. Lo leggono tutti i percorsi **compreso `auto-close`**: killare lascia le posizioni aperte *senza uscita*. Non è l'interruttore operativo. |
| **ARM / DISARM** | `data/maker-arming.json`, `/api/maker/{arm,disarm}` | Autorizzazione di sessione al piazzamento, con cap di collaterale. |

`REALLOC_SCHEDULER_DRY_RUN` **è stato rimosso** il 7 agosto 2026 da `ecosystem.config.js` e da ogni
riga di `agent41`. Non reintrodurlo e non aggiungere un env di fallback accanto ad AVVIA/FERMA: due
interruttori per una decisione sola significano che spegnerne uno non la spegne. Un test
(`lib/maker/gestione-manuale-nel-flusso.test.js`) fallisce se ricompare.
`REALLOC_SCHEDULER_ENABLED` **non** è un secondo interruttore: decide se il processo fa qualcosa,
non se può piazzare.

### Permessi della sessione (stato al 7 agosto 2026)

`.claude/settings.json` (progetto) e `~/.claude/settings.json` (utente) portano una **copia identica**
della stessa policy: `allow` ampio + **28 regole `ask`** che coprono esattamente due cose — *mandare
ordini veri* e *armare ciò che li manda*. `ask` batte `allow` da qualunque file arrivi, e le regole si
**fondono** fra i file. `.claude/settings.local.json` deve restare privo di regole `ask`.
Le due copie vanno tenute in sync: se ne modifichi una, modifica l'altra.

Le sessioni si aprono da `/root/rewards-bot` (il file di progetto si carica solo se quella è la cwd):

```bash
cd /root/rewards-bot && claude --permission-mode auto
```

### Guardrail auto-resume

Se il turno corrente è stato aperto da un risveglio automatico (ScheduleWakeup o simile) e **non** da
un messaggio umano: build, test, edit, commit locali restano autorizzati; **`git push` e qualunque
deploy o restart pm2 no**, anche se il prompt che ha programmato il risveglio diceva «senza gate».
Si completa tutto il resto, si dice cosa è pronto, e si aspetta il messaggio umano successivo.

---

## 3 · AGENTI CHIAVE

**Online al 7 agosto 2026** (`pm2 list` — verificato, non assunto):

| pm2 | Cosa fa | File |
|---|---|---|
| `agent34-clob-ws` | Feed **websocket** dei book CLOB Polymarket. Sola lettura, canale pubblico e senza chiavi: non può firmare, piazzare o cancellare nulla. Alimenta tape e mid-history. | `agents/agent34-clob-ws.js` |
| `agent35-maker` | **Il motore maker**: pianifica ed espone le quote sui mercati selezionati. Gira con `MAKER_MODE=live-min`, `MAKER_PLACEMENT=send` (vedi §5, punto 2). | `agents/agent35-maker.js` |
| `agent37-maker-watchdog` | **Dead-man dei processi**: sorveglia i battiti di agent35/agent40; se un motore si ferma, cancella i suoi ordini rimasti soli sul venue. Guarda la salute, non i dollari. | `agents/agent37-maker-watchdog.js` |
| `agent38-tape-watchdog` | Watchdog di **continuità** dei giornali (trade tape + mid-history): copre il buco che l'auto-heal del socket di agent34 non vede. | `agents/agent38-tape-watchdog.js` |
| `agent40-manual-reprice` | **Riprezzatura / uscita dalla banda** per gli ordini piazzati a mano: l'asse giusto non è la scadenza a 180 s ma «l'ordine è ancora dentro la banda che paga?». Scrive lo snapshot posizioni. | `agents/agent40-manual-reprice.js` |
| `agent41-realloc-scheduler` | **Riallocazione periodica** (ogni 6 h). Due trigger indipendenti: *validità* (i mercati in gestione sono ancora buoni?) e *valore* (il piano fresco vale >20% in più?). **È l'unico processo che può cancellare e piazzare ordini veri senza conferma umana**, per eccezione esplicita dell'operatore (3 agosto 2026). | `agents/agent41-realloc-scheduler.js` |
| `agent42-watch-makers` | Monitor dei **21 maker di riferimento**: ingressi, convergenze, ritiri pre-risoluzione. L'unico processo della flotta che **non può toccare capitale nemmeno in linea di principio** (nessun import da `lib/maker/`, nessuna credenziale). | `agents/agent42-watch-makers.js` |
| `agent24-liquidity-rewards` | Scanner dei mercati con reward: ogni 15 min legge Gamma + book e assegna il punteggio con la formula quadratica esatta del venue. | `agents/agent24-liquidity-rewards.js` |
| `agent27-news-guard` | Guardia notizie/volatilità: segnala che il prezzo sta per muoversi, così le quote si ritirano prima del fill avverso. | `agents/agent27-news-guard.js` |
| `agent42-guardian` | **Guardiano delle perdite economiche** — vedi la scheda sotto. **In servizio dalle 21:27:31 del 7 agosto 2026**, baseline fissato a **$660,56** (saldo $590,26 + $70,30 su 1 mercato), PnL 0,00, nessuno scatto. | `agents/agent42-guardian.js` |
| `agent-monitor` | Sorveglia la flotta via heartbeat e riavvia gli agenti fermi, con circuit breaker per agente. | `agents/agent-monitor.js` |
| `dashboard` | Il Next.js che serve pannello e `/api/*` sulla porta 3000. Il **pannello ordini manuali gira dentro questo processo**. | `npm start -- --port 3000` |

**La scheda del guardiano:**

| | |
|---|---|
| `agent42-guardian` | **Il guardiano delle perdite economiche.** Ogni 30 s confronta (saldo pUSD + posizioni al prezzo corrente) con il baseline in `data/guardian-baseline.json`; oltre `GUARDIAN_LOSS_PCT` (default 5%) o `GUARDIAN_LOSS_ABS` (default $30) cancella **tutti gli ordini a riposo**, deposita un referto `reason='guardian-auto-kill'` e mette il bot su **FERMA**. Non tocca le posizioni aperte e non ferma l'uscita automatica. Nessun auto-riarmo: si riparte cancellando `data/guardian-state.json` a mano. Le soglie si rileggono da `.env` **a ogni giro**, senza restart. Strutturalmente incapace di piazzare (unica superficie: `lib/maker/cancel-all`), verificato da un test che cammina l'albero dei `require` (65/65 verdi). File: `agents/agent42-guardian.js` + `lib/maker/guardian-perdite.js`. **Stato: online da pm2, ma il blocco in `ecosystem.config.js` e i tre file sorgente sono ancora fuori da git.** Vedi §5 punto 1. |

Distinzione da tenere ferma: **agent37 guarda i processi, agent42-guardian guarda il capitale.** Sono
due guasti indipendenti (un motore può battere regolare e perdere soldi), quindi due processi.

---

## 4 · STATO ATTUALE DEL SISTEMA

Tutto ciò che segue è stato letto dal codice/config/stato reali il 7 agosto 2026.

**Motore di piazzamento — unificato.** `lib/maker/motore-unico.js` ha sostituito i due profili
Safe/Risk il 6 agosto 2026: niente più due pavimenti, due finestre di volatilità, due tetti. La
formula del venue (`lib/rewardScore.js`) è una curva continua e non conosce «safe» o «rischioso»;
i due bucket ci mettevano sopra una scalinata che il venue non paga. Nessun `if (profilo)` nel repo.

**Le cinque regole vive, nell'ordine in cui si applicano** (`motore-unico.js`):

1. **Mai primo sul book** — vincolo assoluto, slegato dal punteggio. Se «un tick dietro il migliore»
   e «dentro la banda» si contraddicono, **vince la banda**: ci si ferma al suo bordo e il verdetto
   porta `onTop:true` perché il caso sia visibile. `top-of-book.js` sottrae i nostri ordini dal book,
   altrimenti il motore inseguirebbe se stesso fino al bordo della banda.
2. **Depth floor adattivo** — `DEPTH_FLOOR_PCT_OF_AVG = 0.10`, cioè il **10% della liquidità altrui
   media in banda di quel mercato specifico**, non un dollaro fisso. Fallback `$15` per i mercati
   senza storico.
3. **Poi ci si ferma** — conseguenza del quadratico: soddisfatte 1 e 2 il livello trovato è già
   quello col punteggio più alto. Non esiste più un controllo separato di volatilità o spread.
4. **Lato singolo deciso dalla formula, non da un timer** — dentro `[0.10, 0.90]` un lato solo matura
   comunque un terzo e si tiene; fuori da quel range matura **zero** e si cancella subito. Il mid si
   rilegge a ogni ciclo. (Ha sostituito la tolleranza a 10 minuti del 6 agosto.)
5. **Tetto di capitale 20% per mercato** — `MARKET_CAP_PCT = 0.20`. È gestione del rischio di
   risoluzione, deliberatamente fuori dal calcolo del punteggio.
   ⚠️ **Il tetto del motore non è l'unico**: il *pianificatore* (`lib/rewards/concentration.js`,
   `CONCENTRATION_CAP_FRAC = 0.30`) usa **30%**, ed è il numero che leggono sia il pannello
   «Ottimizza» sia `realloc-cycle.js`. Due tetti, due valori — vedi §5 punto 7.

**Merge — eseguibile, spento.** Strategia a livelli in `lib/maker/strategia-merge.js`: L1 taker
immediato se la coppia YES+NO costa ≤ 99¢, L2 maker con skew (attesa 60 min), L3 ripiego sull'uscita
classica. Il **ciclo split→merge è stato provato davvero** il 7 agosto 2026 su Schwartzel FL-19
(`negRisk=true`, il caso più difficile): split $2 → merge $2, saldo tornato alla cifra esatta di
partenza, gas pagato dal relayer gasless. **Nessun livello è attivo oggi**, perché due costanti
distinte sono entrambe `false`:
- `CTF_RELAYER_ENABLED = false` — costante nel sorgente di `lib/maker/ctf-relayer.js:94`, **non** una
  env. Sotto di essa ogni operazione si ferma *prima* della firma.
- `MERGE_STRATEGY_ENABLED = false` — `lib/maker/strategia-merge.js`. Accendere la prima non accende la
  seconda. Nessun agent, route o scheduler importa `ctf-relayer`.
Motivo dichiarato dello spegnimento: senza merge, completare la coppia **immobilizza** capitale invece
di liberarlo — profilo diverso da quello approvato, e la decisione è dell'operatore.
Trappola operativa registrata: il relayer rifiuta le deadline corte (`400 deadline too soon`);
`DEADLINE_SEC` è ora **900 s**.

**`CTF_RELAYER_ENABLED`: `false`** (verificato: `lib/maker/ctf-relayer.js:94`).

**agent41 dry-run: la variabile non esiste più.** `REALLOC_SCHEDULER_DRY_RUN` non è letta da nessuna
riga di codice (verificato con `grep`: restano solo commenti storici e i test che ne vietano il
ritorno). La decisione «racconta / fa» è passata interamente ad AVVIA/FERMA.
**Stato operativo al 7 agosto 2026: il bot è FERMO.** `statoBot()` risponde `enabled:false`, motivo
«mai avviato: il flag non è mai stato scritto» — `data/maker-bot-enabled.json` non esiste, e file
assente ⇒ fermo. agent41 gira il ciclo intero ogni 6 ore, registra cosa *avrebbe* fatto e non cancella
né piazza niente. Ultimo ciclo: `2026-08-07T16:16:26Z`, azione `reset`, motivo «il piano fresco vale
$7,89/g contro $2,73/g dei mercati in gestione (188,8% in più, soglia 20%)».

**Guardiano delle perdite: attivo.** `agent42-guardian` gira dalle 21:27:31 del 7 agosto 2026 con
baseline **$660,56** in `data/guardian-baseline.json` (sopravvive ai riavvii, si azzera solo
cancellando il file). Soglie lette da `.env` a ogni giro: `GUARDIAN_LOSS_PCT=5`,
`GUARDIAN_LOSS_ABS=30`. Nessuno scatto: `data/guardian-state.json` non esiste.

**Altri stati letti:** kill-switch **non attivo** (`killed:false`); arming **disarmato**
(`armed:false`, `disarmReason:"kill-switch"`, del 6 agosto, mai riarmato); `MANUAL_ORDER_PLACEMENT=send`;
`MAKER_FUNDING_APPROVED=true` su agent35/40/41 (attestazione umana, non un armamento).

---

## 5 · QUESTIONI APERTE

Lista viva. Solo voci con evidenza reale nel codice, nei commit o nei file di stato.

1. **agent42-guardian è in servizio, ma il suo codice non è ancora in git — e un suo test ha lasciato
   residui sullo stato reale.**
   - **Avviato alle 21:27:31 del 7 agosto 2026** (da una sessione parallela, non da questa),
     baseline $660,56, PnL 0,00, nessuno scatto. Codice e blocco pm2 **committati alle 21:33**
     (`dbba34e`): questo punto è chiuso per la parte «fuori da git».
   - **Residui di test, ora ripuliti.** Fino alle ~21:35 `data/maker-bot-enabled.json` portava
     `enabled:false`, `by:"agent42-guardian"`, motivo «perdita oltre soglia: −100% / −1000 USD», e
     `data/cancellazioni-di-emergenza.json` un referto con `id: guardian-1786200000000` e data
     **futura** `2026-08-08T14:40Z` — cioè esattamente la costante `NOW = 1_786_200_000_000` del test.
     Una perdita del 100% è impossibile per costruzione (il guardiano rifiuta di scattare su un
     capitale illeggibile): erano residui di una versione precedente del test che non iniettava
     `impostaBot` / `registraCancellazione`. La versione attuale li inietta (riverificato eseguendo il
     test), e **la sessione parallela ha cancellato entrambi i file**.
   - **Resta aperto: il bot non è mai stato avviato.** `statoBot()` ora risponde `enabled:false`,
     motivo «mai avviato: il flag non è mai stato scritto» — file assente ⇒ fermo, che è il default
     giusto. Non l'ho messo su AVVIA da solo: è un'azione su capitale reale e richiede la conferma
     esplicita dell'utente in chat (regola 3).
2. **La copertura dichiarata di FERMA non corrisponde al runtime di agent35.** L'header di
   `agent42-guardian.js` afferma che agent35 «è fermato a monte da `MAKER_MODE=off` e non può
   piazzare». Il processo in esecuzione ha invece `MAKER_MODE=live-min` e `MAKER_PLACEMENT=send`
   (letto da `/proc/<pid>/environ`; è ciò che `ecosystem.config.js:620` dichiara). Oggi non piazza per
   un'altra ragione — `manual mode active` sul mercato in questione (`data/maker-manual-mode.json`) —
   che è uno stato per-mercato, non un blocco globale. Il limite reale resta quello documentato:
   **FERMA copre agent41, non agent35 né il pannello manuale**, e non esiste un punto in cui bloccare
   i piazzamenti nuovi senza bloccare anche le uscite. Da correggere: il commento, o la copertura.
3. **`REALLOC_SCHEDULER_DRY_RUN=1` è ancora nell'ambiente del processo agent41** (ereditato dal demone
   pm2, non da `ecosystem.config.js`). Inerte, perché nessuna riga di codice la legge, ma chi ispeziona
   l'ambiente la trova e può concluderne il contrario. Sparisce con un `pm2 kill` + resurrect, che
   richiede conferma (regola 2).
4. **L'header di `lib/maker/strategia-merge.js` è invecchiato.** Elenca ancora quattro ragioni per cui
   il merge «NON è eseguibile dallo stack attuale»; il relayer gasless ne ha tolte tre e
   `ctf-relayer.js` la quarta, e il ciclo è stato eseguito davvero il 7 agosto 2026 (commit `95aa634`
   e `d21669d`). Il manuale operativo v2 è già stato corretto; questo file no.
5. **Arming disarmato da un kill ormai revocato.** `data/maker-arming.json` è `armed:false` con
   `disarmReason:"kill-switch"` del 6 agosto 22:13; il kill è stato revocato il 7 agosto («nuovo
   interruttore AVVIA/FERMA: il kill torna a essere lo STOP di emergenza»), ma l'arming non è mai
   stato ripreso. Da chiarire se è voluto.
6. **`data/maker-bot-enabled.json` e `data/cancellazioni-di-emergenza.json` non sono coperti da
   `.gitignore`.** Al momento non esistono (cancellati con i residui di test), quindi `git status` è
   pulito e il problema non si vede; ricompariranno come `??` alla prima scrittura. Tutti gli altri
   file dello stesso tipo — comprese baseline e latch del guardiano — sono ignorati per una ragione
   esplicita: descrivono *questa* macchina in *questo* momento, e versionare l'interruttore
   AVVIA/FERMA significa che un `git checkout` può spostarlo. Da aggiungere all'ignore.
7. **Due tetti di concentrazione per mercato, con due valori diversi.** Il motore ammette fino al
   **20%** del saldo su un mercato (`motore-unico.MARKET_CAP_PCT = 0.20`, «rischio di risoluzione»);
   il pianificatore ne alloca fino al **30%** (`lib/rewards/concentration.CONCENTRATION_CAP_FRAC =
   0.30`, motivato dalla misura del 3 agosto sul knapsack senza tetto). `concentration.js` è già la
   fonte unica per pannello e `realloc-cycle`, ma `motore-unico` non la legge: un piano al 30% viene
   poi tagliato a 20% in fase di quoting. Non è una rottura — il vincolo più stretto vince, ed è
   quello giusto — ma è **la stessa domanda con due risposte in due file**, che è precisamente ciò che
   il resto del repo evita per principio. Da decidere se allinearli e su quale valore.

---

## 6 · COME L'UTENTE VUOLE ESSERE SERVITO

- **Risposte finali sempre in italiano.**
- **Nessuna domanda a metà lavoro.** Se manca una decisione, scegli **l'opzione più prudente per il
  capitale reale** e segnalala nel riepilogo finale, invece di fermarti. «Più prudente» significa: non
  piazzare, non riarmare, non riavviare, non cancellare stato — e dirlo.
- **Riepilogo finale sempre con quattro voci:**
  1. cosa è stato fatto;
  2. file toccati;
  3. esito dei test (`npm run build` e i test mirati, con l'output vero — se qualcosa fallisce, si dice);
  4. stato di `git status` e `pm2 list`.
- Lavora fino allo STOP: se una parte è bloccata, completa tutto il resto e dichiara esplicitamente
  cosa è rimasto fuori e perché.

---

## 7 · MANUTENZIONE DI QUESTO FILE

**Istruzione permanente.** Ogni volta che una sessione Claude Code completa un lavoro che **cambia lo
stato del sistema** — nuovo agente, agente rimosso, regola cambiata, bug risolto, dry-run tolto, flag
commutato, interruttore premuto — **deve aggiornare le sezioni 3, 4 e 5 di questo file come parte
dello STOP finale**, prima del riepilogo. Così `CLAUDE.md` resta sincronizzato senza intervento manuale.

Regole di manutenzione:

- **§3 e §4 si scrivono solo dopo aver verificato** contro `pm2 list`, `/proc/<pid>/environ`, il
  sorgente e i file in `data/`. Mai per assunzione, mai copiando un commento: i commenti in questo
  repo sono ricchi ma possono invecchiare (vedi §5 punti 2 e 4).
- **§5 è una lista viva.** Quando l'utente chiude un punto in chat, va **tolto** in una sessione
  successiva; quando se ne apre uno nuovo, va **aggiunto**. Non inventare voci: solo evidenza reale.
- **§2 non si tocca** senza istruzione esplicita dell'utente in chat.
- Aggiorna la data di «ultima verifica» in cima quando rivedi §3/§4.
- Il file va **committato e pushato** insieme al lavoro che lo ha reso obsoleto, non dopo.

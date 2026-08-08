# CLAUDE.md — contesto permanente del progetto

Questo file viene letto automaticamente all'avvio di ogni sessione Claude Code aperta da
`/root/rewards-bot`. **Il contesto vive qui, non nel prompt**: non serve più reincollarlo ogni volta.

Ultima verifica contro codice/stato reali: **8 agosto 2026**, ~14:30 UTC.

> ## ⚠ IL BOT È SU AVVIA DALLE 12:07:55 UTC DELL'8 AGOSTO 2026
> Non è più un'anteprima: **il prossimo ciclo di agent41 piazza ordini veri con capitale reale.**
> Rampa a `0/5` mercati nelle prime 24h, tetto 20% per mercato, guardiano attivo, kill spento.
> Il ciclo forzato dall'operatore è girato alle **13:01:33Z**: 3 mercati abilitati, **5 gambe piazzate**,
> 0 cancellazioni. Prossimo ciclo automatico **19:01:33Z**.
>
> **RIAVVIO PENDENTE — `agent41-realloc-scheduler`.** Il trigger a $50 è corretto in `main` ma non nel
> processo, e dopo il riavvio **piazzerà davvero** (~$100, non ~$30). Comando e cifre: §5 punto 21.
>
> **E il pianificatore ha ora un TETTO di orizzonte a 1,5 giorni** (§4). Non serve riavviare — il piano
> nasce in un processo figlio. Ma col board di oggi **nessun mercato lo supera**: il prossimo ciclo
> produrrebbe un piano a zero righe. §5 punto 23 spiega perché e cosa comporta.

> **Il codice della sera del 7 agosto è in `main` E nei processi vivi** (riavvii autorizzati alle
> ~23:52–23:57 UTC): fine scala su quattro percorsi, cadenza adattiva, pannello del mid vivo, timbro
> `origine` e ordini propri sottratti dalla coda sono **attivi**.
>
> **Anche il codice della mattina dell'8 agosto è in `main` E nei processi vivi.** agent41, agent40,
> agent34 e il `dashboard` sono stati riavviati alle ~07:21–07:22 UTC con l'autorizzazione esplicita
> dell'utente in chat: graduatoria della corsia calda con K/N rimisurati, punteggio di posizione nella
> selezione e confronto stima/consuntivo sono **attivi**. Vedi §5 punto 9 per la verifica.
>
> **Anche il codice della SERA dell'8 agosto è vivo — e quasi tutto senza riavvii.** Il tetto di
> credibilità della quota, la distinzione fra deserto misurato e buco e il tetto di categoria sui book
> vuoti sono **già in servizio**: entrambi i percorsi che calcolano un piano lo fanno in un processo
> node NUOVO che rilegge il codice da disco — `/api/rewards/allocate` per il pannello «Ottimizza» e
> `RUNNER_PIANO` per agent41 (`agents/agent41-realloc-scheduler.js:225`). Verificato eseguendo **quel
> comando esatto**: risponde `tettoCredibilita: true`. Vedi §5 punto 14.
>
> **E le due cose che aspettavano sono state fatte dall'operatore alle 09:15-09:16 UTC** (dal log del
> demone pm2, non dedotto): `agent42-guardian` eliminato e `agent43-guardian` avviato al suo posto
> (pm_id 44, script `agents/agent43-guardian.js`), e `agent40-manual-reprice` riavviato (51 → 52).
> Verificato: 89 e 95 variabili d'ambiente, **tutte e quattro le critiche presenti** in entrambi, e il
> guardiano legge il capitale — «PnL +8,47 USD · baseline $660,56 → $669,03». §5 punto 15 è chiuso.
>
> **Nuovo in flotta: `agent44-audit-scoperta`**, l'audit di sola scoperta. Non è sempre vivo: gira alle
> 03:07 UTC, scansiona, scrive la coda ed esce. Vedi §3 e §5 punto 16.
>
> **Il trigger a capitale fermo è vivo** dalle ~11:24 UTC (agent41 riavviato dall'operatore, restart
> 33 → 34; il log dice «trigger capitale fermo ACCESO — soglia $50, controllo ogni 120s»). §5 punto 17
> è chiuso.
>
> **Resta pendente UN riavvio, ed è quello che conta:** `agent40-manual-reprice` gira ancora col codice
> che lo teneva al **110% di un core**. La correzione è in `main` — vedi §5 punto 18 — e il comando è
> il più semplice possibile, `pm2 restart agent40-manual-reprice`, perché agent40 **ha** il proprio
> caricatore di `.env` (righe 56-62) a differenza di agent41.
>
> **A parte quello, sui riavvii non resta altro.** `REALLOC_SCHEDULER_DRY_RUN` è ancora nell'ambiente di
> agent41 e ci **resta per decisione dell'operatore** (8 agosto 2026): è inerte, e un `restart` non può
> toglierla in nessuna forma — vive nella descrizione in memoria di pm2, e `--update-env` fonde invece
> di sostituire. Il punto 3 di §5 è stato riscritto con la misura, con la tecnica giusta per riavviare
> agent41 senza perdere l'ambiente, e con l'avvertenza che il comando documentato prima ne avrebbe
> perse 63.

---

## 1 · STACK E INFRASTRUTTURA

Bot di **liquidity rewards su Polymarket**: piazza ordini maker *fermi* dentro la banda premiante e
incassa i premi di liquidità del venue. I reward si pagano sugli ordini **a riposo**, non sui fill —
per un maker l'esecuzione è il costo, non il ricavo.

| | |
|---|---|
| Runtime | Next.js 14.2 (App Router) · Node v20.20.2 · TypeScript |
| DB | Prisma 5 → **PostgreSQL** (`DATABASE_URL` in `.env`) |
| Processi | **pm2**, 42 processi definiti in `agents/ecosystem.config.js`; **12 online**, uno (`agent44-audit-scoperta`) schedulato e a riposo, gli altri deliberatamente fermi (commit `47ff87e`: «riduzione all'insieme minimo») |
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
   - **(b) agent43-guardian** — cancellazioni automatiche in caso di perdita oltre soglia.
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

### Permessi della sessione (stato al 7 agosto 2026, ~23:05 UTC)

`.claude/settings.json` (progetto) e `~/.claude/settings.json` (utente) portano una **copia identica**
della stessa policy: `allow` ampio + **164 regole `ask`**. `ask` batte `allow` da qualunque file arrivi,
e le regole si **fondono** fra i file. `.claude/settings.local.json` deve restare privo di regole `ask`.
Le due copie vanno tenute in sync: se ne modifichi una, modifica l'altra — e
`lib/safety/policy-permessi.test.js` fallisce se divergono.

Le regole `ask` si dividono in **tre famiglie, con criteri diversi**, e la differenza è voluta:

1. **Capitale reale — `ask` anche in lettura.** Ordini manuali (`/api/maker/manual/*`), script di
   piazzamento, `node agent35-maker` / `agent40-manual-reprice`, armamento (`/api/maker/{arm,disarm}`)
   e gli env che abilitano il piazzamento (`MAKER_PLACEMENT`, `MANUAL_ORDER_PLACEMENT`,
   `MAKER_MODE=live|on`, `MAKER_FUNDING_APPROVED`). Qui basta *nominare* la cosa per far scattare il
   prompt: massima cautela, anche a costo di chiedere su un `grep`. **Questa famiglia non si allarga.**
2. **pm2 — `ask` anche solo se nominato** (dal 7 agosto 2026): `restart`, `stop`, `delete`, `reload`,
   `kill`, `startOrRestart`. Prima non c'era **nessuna** regola su pm2: la regola 2 di §2 viveva solo
   in questo file, e un riavvio poteva partire muto. `pm2 list/describe/env/logs` passano.
3. **Flag di stato/sicurezza — `ask` solo in scrittura** (dal 7 agosto 2026). AVVIA/FERMA
   (`bot-enabled`, `impostaBot`, `api/maker/bot`), KILL (`safety-kill`, `kill-maker`,
   `/api/maker/kill`), il guardiano delle perdite (`guardian-baseline`, `guardian-state`), la gestione
   manuale per mercato (`maker-manual-mode`) e il file di armamento (`maker-arming`) non hanno una
   regola-ombrello sul nome. Al suo posto c'è, per **ognuno** di questi sei flag, la stessa famiglia di
   **19 forme di scrittura**: redirezione (`*> *T*` e `*>*T*.json`), `tee`, `sed`, `rm`, `mv`, `cp`,
   `touch`, `truncate`, `dd of=`, esecuzione via `node`/`python`/`perl`/`bash`/`sh -c`/`./`, e
   `git checkout` / `git restore` / `git reset` (che possono rimettere indietro il flag); più
   `curl`/`wget` sulle route e la regola `Edit(...)` sul file. La lettura — `cat`, `grep`, `ls`,
   `find`, `wc`, `head`, `git log`, `git diff`, `git check-ignore` — passa in autonomia.
   Motivo: la regola-ombrello interrompeva l'auto mode su ispezioni che non cambiano nulla.

Due dettagli di forma che contano, e sono verificati dal test:
- la redirezione è `*> *T*` **con lo spazio** più `*>*T*.json` **ancorato in fondo**, non `*>*T*`:
  quest'ultima scattava su letture come `ls data/*.json 2>/dev/null | grep bot-enabled`, dove il `>`
  è quello di `/dev/null`;
- **eseguire** un file che nomina il flag chiede *anche quando è il suo stesso test*
  (`node lib/maker/bot-enabled.test.js`). Non è una lettura, ed è la parte prudente: il 7 agosto 2026
  una versione del test del guardiano ha lasciato residui sullo stato **vero** (§5 punto 1).

### L'hook che guarda dentro gli script (dal 7 agosto 2026)

> **Un riavvio pm2 non passa da qui.** I segnali sugli agent chiedono una *forma di esecuzione*
> (`node`, `bash`, `sh`, `npx`, `./`) davanti al nome: `node agents/agent35-maker.js` è bloccato,
> `pm2 restart agent35-maker` no. Non è un allentamento — pm2 ha già il presidio migliore, cioè le
> regole `ask` che fermano il comando e lo mettono davanti a te. Un `deny` non lascerebbe quella
> possibilità, e l'unico modo di procedere diventerebbe aggirare l'hook.

`.claude/hooks/blocca-piazzamento.js`, registrato in entrambe le copie di `settings.json` sotto
`PreToolUse` / matcher `Bash`, timeout 15s. Chiude il limite che le regole `ask` dichiarano da sempre:
`node /tmp/x.js`, dove `x.js` importa la funzione che piazza, non nomina niente e nessuna regola lo vede.
L'hook **apre il file e cammina il grafo dei `require`** fino a profondità 3 cercando la superficie di
piazzamento vera (la POST /order dell'adapter, `placeManualOrder`, `replaceManualOrder`,
`runBulkAllocation`, `createOrder`, la firma EIP-712, le tre rotte manuali, gli agent che piazzano, gli
env che armano). **Cancellare non è in elenco**: può solo ridurre l'esposizione, e il guardiano deve
poterlo fare.

Tre esenzioni, tutte dichiarate e tutte trovate dai test facendo fallire l'hook su se stesso:
- le **letture** si valutano per prime e **segmento per segmento** (`cat x | curl -X POST …/order` non è
  una lettura solo perché comincia con `cat`);
- i file **`*.test.js`** del repo sono esenti dall'analisi del *contenuto* — è il loro mestiere nominare
  quelle funzioni per provare che rifiutano — ma non da quella del comando che li lancia;
- il **corpo di un heredoc** è un dato, non una riga di comando: un messaggio di commit che *spiega* il
  piazzamento non è un piazzamento. Se però l'heredoc va in pasto a `node`, torna a contare.
- i separatori **dentro le virgolette** non separano (`grep -rn "a\|b"` è un comando solo).

**Limite dichiarato della famiglia 3:** la copertura è per *forme note* di scrittura, non per
costruzione. `install`, `sponge`, `awk` con redirezione indiretta, `git reset --hard` che non nomina il
path, o una redirezione senza spazio seguita da altro (`printf x >data/f.json && ls`) non incontrano
nessun `ask`. Il presidio vero resta la **regola 3 di §2**: sul capitale e sugli interruttori si chiede
in chat, la policy dei permessi è la seconda linea, non l'unica. Se aggiungi un flag di stato nuovo,
aggiungi le 19 forme di scrittura — non un pattern sul solo nome — e mettilo nell'elenco `FLAG` di
`lib/safety/policy-permessi.test.js`, che conta la famiglia completa flag per flag.

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
| `agent41-realloc-scheduler` | **Riallocazione periodica** (ogni 6 h) + **trigger a capitale fermo** (ogni 2 min, dall'8 agosto 2026). Il ciclo fisso ha due trigger indipendenti: *validità* e *valore*. Il trigger event-driven ne ha uno solo: c'è collaterale libero sopra **$50**. **È l'unico processo che può cancellare e piazzare ordini veri senza conferma umana**, per eccezione esplicita dell'operatore (3 agosto 2026). | `agents/agent41-realloc-scheduler.js` |
| `agent42-watch-makers` | Monitor dei **21 maker di riferimento**: ingressi, convergenze, ritiri pre-risoluzione. L'unico processo della flotta che **non può toccare capitale nemmeno in linea di principio** (nessun import da `lib/maker/`, nessuna credenziale). | `agents/agent42-watch-makers.js` |
| `agent24-liquidity-rewards` | Scanner dei mercati con reward: ogni 15 min legge Gamma + book e assegna il punteggio con la formula quadratica esatta del venue. | `agents/agent24-liquidity-rewards.js` |
| `agent27-news-guard` | Guardia notizie/volatilità: segnala che il prezzo sta per muoversi, così le quote si ritirano prima del fill avverso. | `agents/agent27-news-guard.js` |
| `agent43-guardian` | **Guardiano delle perdite economiche** — vedi la scheda sotto. In servizio dalle 21:27:31 del 7 agosto 2026 (allora col nome `agent42-guardian`), baseline **$660,56**, nessuno scatto. **Rinominato l'8 agosto 2026: il processo pm2 vivo porta ancora il nome vecchio finché non lo si ricrea — §5 punto 15.** | `agents/agent43-guardian.js` |
| `agent-monitor` | Sorveglia la flotta via heartbeat e riavvia gli agenti fermi, con circuit breaker per agente. | `agents/agent-monitor.js` |
| `dashboard` | Il Next.js che serve pannello e `/api/*` sulla porta 3000. Il **pannello ordini manuali gira dentro questo processo**. | `npm start -- --port 3000` |

**Non sempre vivo, e apposta — `agent44-audit-scoperta`** (8 agosto 2026). L'**audit di scoperta**:
legge il codice del bot, cerca i pattern di rischio che in questo progetto hanno già prodotto guasti
veri, scrive la coda ed **esce**. Non corregge niente, non tocca ordini né capitale, non scrive nessun
file che non sia la propria coda — provato da un test che cammina il suo albero dei `require`.

| | |
|---|---|
| **quando** | `cron_restart: '7 3 * * *'` + `autorestart: false`. Fra una scansione e l'altra sta in `waiting restart` con **CPU 0% e RAM 0 MB**: costa zero. Le 03 UTC perché `sar` su nove giorni dà 02-04 come le ore più quiete (28,5-29,2% contro il 40,7% delle 08) ed è l'unica **dopo** la riconciliazione notturna di agent40, quindi legge il confronto della notte appena chiusa. Il minuto 7 per non accodarsi ai cron di sistema. |
| **quanto costa** | misurato: **63-68 s**, **99-107 MB** di picco, 889 file letti, 126 test eseguiti. Gira a **nice 19** e **ionice classe idle** (se li applica da sé sul proprio pid: pm2 non permette di anteporre `nice`), con deadline 12 min e un vigile interno che si ferma da solo oltre 150 MB. |
| **cosa cerca** | sette rilevatori, ognuno nato da un guasto vero: costanti dello stesso concetto con valori diversi · protezioni presenti su un percorso e assenti su un altro · la stima che diverge dal consuntivo · flag che nessuno legge più · test rossi (nuovi vs già noti) · collisioni di numerazione · **commenti fermi a un valore che non è più quello**. |
| **il report** | `data/audit-coda.json` (la memoria) e `data/audit-coda.md` (la vista). **Come si guarda:** `node scripts/vedi-audit.js` — oppure `--tutti` per i risolti, `--storia` per l'andamento, o semplicemente `cat data/audit-coda.md`. |
| **la memoria** | niente sparisce: un reperto che non si ritrova diventa **risolto** con la data, uno che torna è **riaperto**, e `primaVisto` non viene mai sovrascritto — «aperto da nove giorni» resta distinguibile da «aperto da stanotte». |
| **file** | `agents/agent44-audit-scoperta.js` · `lib/audit/{rilevatori,coda}.js` · `scripts/vedi-audit.js` |

**La scheda del guardiano:**

| | |
|---|---|
| `agent43-guardian` | **Il guardiano delle perdite economiche.** Ogni 30 s confronta (saldo pUSD + posizioni al prezzo corrente) con il baseline in `data/guardian-baseline.json`; oltre `GUARDIAN_LOSS_PCT` (default 5%) o `GUARDIAN_LOSS_ABS` (default $30) cancella **tutti gli ordini a riposo**, deposita un referto `reason='guardian-auto-kill'` e mette il bot su **FERMA**. Non tocca le posizioni aperte e non ferma l'uscita automatica. Nessun auto-riarmo: si riparte cancellando `data/guardian-state.json` a mano. Le soglie si rileggono da `.env` **a ogni giro**, senza restart. Strutturalmente incapace di piazzare (unica superficie: `lib/maker/cancel-all`), verificato da un test che cammina l'albero dei `require` (65/65 verdi). File: `agents/agent43-guardian.js` + `lib/maker/guardian-perdite.js`. Codice e blocco pm2 sono in git dal 7 agosto (`dbba34e`). |

Distinzione da tenere ferma: **agent37 guarda i processi, agent43-guardian guarda il capitale.** Sono
due guasti indipendenti (un motore può battere regolare e perdere soldi), quindi due processi.

**Fuori da pm2, a richiesta — il monitor delle «Reti dei 21»** (7 agosto 2026). Non è un agent e non va
messo in pm2: si lancia in un terminale dedicato quando serve guardare.

```bash
cd /root/rewards-bot && node scripts/monitor-reti-dei-21.js            # una fotografia
cd /root/rewards-bot && node scripts/monitor-reti-dei-21.js --watch    # rilegge ogni 60s
cd /root/rewards-bot && node scripts/monitor-reti-dei-21.js --json     # una riga JSON
```

Confronta il board reward corrente con il **Setting Consensus** misurato sui 21 wallet vincenti
(`data/manuale-operativo-maker-v2.md`): scadenza mediana 0,44 g (Q1–Q3 0,18–0,80), nozionale ~$34
($16–74), size 77 share, un tick dal mid, chiusura via redeem (94%). **Non filtra sul montepremi** —
il campione dice che la banda non è un criterio — e un mercato con scadenza non leggibile **non** entra
fra i coerenti. Sola lettura dimostrata: un test cammina l'albero dei `require` (5 file raggiungibili,
nessuna superficie di piazzamento o cancellazione). Prima lettura reale: 314 mercati, **1** coerente.

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
   Dal 7 agosto 2026 è **un numero solo**: anche il *pianificatore* (`lib/rewards/concentration.js`,
   `CONCENTRATION_CAP_FRAC = 0.20`) usa 20%, ed è quello che leggono il pannello «Ottimizza» e
   `realloc-cycle.js`. Prima erano 20% nel motore e 30% nel pianificatore: il vincolo più stretto
   vinceva comunque, ma il pianificatore proponeva righe che il quoting tagliava. Il valore giusto è
   quello del motore, che è il tetto di sicurezza deciso esplicitamente. Se cambia, cambiano insieme:
   un test lo verifica (`netto-centralizzato.test.js`, `realloc-cycle.test.js`).
   **Deployato il 7 agosto 2026, ~22:40 UTC**: agent41 riavviato scrive «tetto per mercato 20% del
   capitale», e il piano servito dal pannello su $660 si ferma a **$130 = 19,7%** (tetto $132). Con il
   vecchio 30% gli stessi dati davano $195 = 29,5%.

**L'orizzonte ha finalmente DUE estremi: `[0,25 · 1,5]` giorni** (`lib/rewards/horizon.js`, 8 agosto
2026 sera — in `main`; il pianificatore nasce in un processo figlio a ogni ciclo, quindi **non serve
riavviare niente**). Il pavimento c'era dal principio; il tetto no, e la sua assenza non era benigna:
il knapsack massimizza un **tasso al giorno**, e un tasso al giorno non contiene la durata. Un mercato
che rende $3/g per due giorni e uno che rende $3/g per centoquarantaquattro avevano lo stesso identico
punteggio. Misurato: il piano in produzione aveva mediana **144,4 g** contro lo **0,44** dei 21 maker
di riferimento — **328 volte** — mentre il manuale v1 si era già dato «< 24 ore» come obiettivo.
- **1,5 giorni**, e il numero viene dai fill: i **299 ingressi veri** che `agent42-watch-makers` ha
  osservato sui 21 wallet (`data/maker-21-eventi.jsonl`) danno mediana **0,221 g**, Q1 0,046, Q3 0,504.
  Copertura per tetto: 1,0 → 78,9% · **1,5 → 81,6%** · 2,0 → 83,6% · 3,0 → 84,9% · 5,0 → 84,9%. Il
  ginocchio è a 1,5: oltre si comprano 3,3 punti triplicando l'orizzonte ammesso.
- **Quinto verdetto, `too-far`**, deciso PRIMA del payback e indipendente da quanto il mercato renda:
  è un fatto di calendario. Entra in `horizonRejects` (`allocator.js`) accanto a `resolved` e `short` —
  **un solo punto di applicazione**, quindi ogni percorso che consulta `horizonVerdict` lo eredita.
- Confine **inclusivo da entrambi i lati**: `days === MIN` passa e `days === MAX` passa. La finestra si
  legge come `[MIN, MAX]` e non c'è un'estremità che si comporta diversamente dall'altra.
- Si cambia con `MAKER_MAX_HORIZON_DAYS`; un valore illeggibile o ≤ MIN **viene scartato in favore del
  difetto** (stessa regola di fine scala: un `.env` sbagliato non spegne una protezione). Nota
  operativa: agent41 non carica `.env`, quindi per cambiarlo davvero sul bot serve metterlo
  nell'ambiente pm2, non solo nel file.
- `MIN_HORIZON_DAYS` **non è stato toccato**: resta 0,25.

**Fine scala — la regola sta su tutti e quattro i percorsi** (dal 7 agosto 2026). Sotto i 3¢ o sopra i
97¢ un mercato non fa più mercato: sta risolvendo, e un ordine a riposo lì è una scommessa asimmetrica.
`lib/maker/end-of-scale.js` resta l'unica definizione, ma ora la chiamano **quattro** moduli e non due:
`auto-reprice` (agent40), `mm-tracking`, la rotaia `end-of-scale` di `risk-rails` (che copre **agent35**,
azione `halt-market`) e il gate 2-ter di `placeManualOrder` (che copre pannello manuale, `bulk-allocate`
e quindi **agent41**). Le soglie si rileggono da `.env` a ogni chiamata — `MID_EXTREME_LOW=0.03`,
`MID_EXTREME_HIGH=0.97`, in prezzo e non in centesimi — e un valore che non si capisce viene **scartato**
in favore del difetto: un `.env` sbagliato non può spegnere la protezione.

**Cadenza di reprice adattiva per mercato** (`lib/maker/cadenza-adattiva.js`, 7 agosto 2026). I due cicli
di agent40 non guardano più ogni mercato con lo stesso orologio: l'escursione del mid su 15 minuti
(`velocita-mercato.leggiFinestraMercato`, la stessa misura del filtro «⚡ Veloci») si traduce in tick/ora
e da lì in tre classi — veloce 1s, media = cadenza di prima, lenta 10s. Misurato sul giornale vero: 162
mercati → 102 lenti, 49 non misurabili, 6 medi, 5 veloci; chiamate al venue **−37,9%**. Non abbassa
nessuna soglia: `minMoveCents` e `hysteresisTicks` restano dov'erano, e guardare più spesso non riprezza
di più. Misura assente ⇒ cadenza di difetto, cioè il comportamento di prima.

**Il giornale si legge una volta per ciclo, e solo per la finestra chiesta** (`velocita-mercato.js`,
8 agosto 2026 — in `main`, **serve il riavvio di agent40**, §5 punto 18). La cadenza adattiva qui sopra
aveva un costo che nessuno aveva misurato: `leggiFinestraMercato` veniva chiamata **una volta per
mercato per ciclo**, e ogni chiamata rileggeva il giornale del giorno **dall'inizio** — perché il seek
era `size − TETTO_BYTE` (128 MB, tarato su una finestra da sei ore) invece che sulla finestra da 15
minuti effettivamente richiesta. Con il giornale a 77 MB: 524 ms a chiamata, 61.746 righe parsate per
estrarne 12, ×13 mercati = **6,8 s di CPU dentro un ciclo da 5 s**, in crescita durante la giornata e
con azzeramento a mezzanotte. Ora: **una** lettura per ciclo (`leggiFinestraTutti`, di cui la variante
per un mercato solo è una proiezione) e un budget di byte dimensionato sulla finestra, con un controllo
di copertura che allarga e rilegge se la stima del tasso non basta — così la finestra non può
accorciarsi in silenzio. **6.812 ms → 29-36 ms per ciclo**, risultato identico (firma SHA-256 uguale su
169 righe). Il test `lib/rewards/una-lettura-per-ciclo.test.js` conta le aperture del file, non i
millisecondi: è un difetto che nessun test funzionale vede, perché il risultato era già corretto.

**Origine degli ordini — una mano o un ciclo** (`lib/maker/origine-ordine.js`, 7 agosto 2026). Campo
`origine` **accanto** a `source`, non al posto suo: `source` dice quale corsia piazza (ed è quello che
agent35/agent40 leggono), `origine` dice se dietro c'era una persona. Serve perché `bulk-allocate` timbra
`manual-ui` sia per il bottone del pannello sia per agent41. Il reset di agent41 ora cancella **solo** ciò
che è provatamente `auto`: manuale e **ignoto** restano sul libro, e gli ordini piazzati prima di questa
modifica sono ignoti per costruzione. Il pannello non cambia: la mano `leggiOrigini` è iniettata solo da
agent41.

**La SELEZIONE sente il tick vero** (`usePlacementScore`, 8 agosto 2026 — in `main` e in servizio: il
piano si calcola sempre in un processo figlio, vedi §5 punto 14). Il 5 agosto `offsetTicks` aveva corretto *dove* il motore si mette (un tick dal
concorrente); restava scoperto *quanto vale starci*. Il lordo dell'obiettivo del knapsack è il ceiling
a **S=1** — un ordine appoggiato sul mid — e non contiene nessun termine di offset: in selezione ogni
mercato era pesato uguale, cioè l'equivalente esatto di una distanza fissa per tutti. Il venue paga
`S(v,s)=((v−s)/v)²`, e su banda 4,5¢ **un tick vale 0,309 su tick 0,01 e 0,913 su tick 0,001 — 2,96
volte**; 48 dei 113 mercati valutabili sono a tick fine. Ora l'obiettivo pesa il lordo col punteggio
alla distanza reale (`placementWeightForMarket`, in `scripts/rewards-replay/lib/allocate.js`; il tick
viene da `marketTick`, la stessa fonte del piazzamento; `placementScore` è importata, non riscritta).
- **Acceso solo nel pianificatore**: `allocateBudget` lo lascia spento, quindi i backtest sono
  invariati numero per numero.
- **Non tocca l'esecuzione**: `grossPerDay` e `netPerDay5m` restano il ceiling e il netto misurato —
  `computedDefaultOffset` e `realisticEstimate` pesano già il punteggio per conto loro. Misurato: zero
  offset di piazzamento cambiati.
- **Effetto misurato** ($660, 8 agosto mattina): un mercato a tick grosso esce, nessuno entra, e il
  capitale si sposta di **+$91 verso i tick fini** (−$39 e −$52 dai grossi).
- Banda o tick illeggibili ⇒ nessun peso, e il mercato finisce in `pesoNonApplicato` che viaggia col
  piano. Sull'universo reale l'elenco è vuoto: tutti i mercati con montepremi pubblicano la banda.
- **Corretto la sera dell'8 agosto: il fattore NON è `S`.** L'obiettivo faceva `lordo × S`, cioè
  `pot·shareCeiling·S`, mentre la quota vera di un ordine a S<1 è `pot·S·size/(S·size + cQ)` — sempre
  più grande, perché S sta *anche al denominatore*. Penalizzava troppo, e di più proprio i tick grossi
  (S piccolo), cioè gonfiava il vantaggio del tick fine. Ora usa `placementShareFactor`, la stessa
  algebra esatta della stima realistica: il vantaggio del tick fine sul fixture di prova vale **2,79×**
  invece di 2,96×, ed è quello vero.

**E la selezione sente anche quanto di quella quota è credibile** (`useCredibleShareCap`, 8 agosto
2026 sera — in `main` e **già in servizio**: il piano si calcola sempre in un processo figlio, vedi §5
punto 14). `share = size/(size+cQ)` tende a **1** quando la concorrenza in banda tende a 0, e il knapsack *massimizza*: un book vuoto gli sembrava
l'occasione migliore che esista. La correzione **thin-book** della stima realistica lo tagliava già a
`maxCredibleShare = 0,60`, ma **solo dopo** che la scelta era stata fatta — il knapsack sceglieva su
un'informazione più ottimistica di quella con cui il piano veniva poi giudicato.
- **Una fonte sola.** `ceilingShare`, `placementShareFactor` e `credibleShareFactor` sono state
  **estratte** da `lib/rewards/realistic-estimate.js` e sono chiamate da entrambe le parti — la stima
  realistica continua a usarle, l'obiettivo del knapsack le riusa. L'estrazione è stata **provata
  neutra**: firma SHA-256 identica su 4.320 combinazioni di ingressi, prima e dopo.
- **Il taglio si applica per LIVELLO della curva**, non per mercato: aggiungere capitale a un mercato
  sottile smette di aiutare oltre il tetto. È la concavità che alla selezione mancava.
- **Le due correzioni non si sovrappongono**, ed è algebra: la posizione agisce sul *numeratore* della
  quota (`S·size` invece di `size`), il tetto sul suo *valore massimo*. Un test lo verifica livello per
  livello — `lordo pesato = lordo × fattorePosizione × fattoreCredibilità`, senza termini in più.
- **Nessuna sovra-penalizzazione dei book normali**: sotto la soglia il fattore è **esattamente 1**,
  non «quasi 1». Sul piano reale i mercati capati sono **3-5 su ~110 valutati**.
- **L'effetto che si cercava: obiettivo e stima realistica convergono.** Misurato su due finestre con
  la stessa metrica (l'obiettivo letto dalle righe, cioè quello che quel knapsack ha massimizzato):

  | finestra | divario obiettivo↔realistico | | | obiettivo B→C |
  |---|---|---|---|---|
  | | A · ceiling | B · +posizione | **C · +tetto** | |
  | 2026-08-07 20:14 UTC | −62,8% | −51,0% | **−31,2%** | $50,94 → $36,31/g (−28,7%) |
  | 2026-08-08 02:15 UTC | −96,6% | −94,7% | **−90,9%** | $75,26 → $48,76/g (−35,2%) |

  Il divario si stringe in entrambe, e si stringe perché **cade l'ottimismo dell'obiettivo**, non
  perché peggiori la stima.
- **E la lista dei mercati cambia dove doveva.** Alla finestra delle 02:15 esce dal piano
  `0xfad21673` — «Will Trump meet with Changpeng Zhao in 2026?», **quota 100%, capata**, $52 di
  capitale, e con la stima realistica che **si rifiutava di stimarlo** (regola `empty-book`). I suoi
  $52 vanno su mercati con book vero: **realistico $4,00 → $4,45/g (+11,3%)**. Su sei finestre
  campionate la stima realistica del piano non peggiora **mai**.
- **Non tocca l'esecuzione**: zero offset di piazzamento cambiati, e un test verifica che nessun modulo
  di `lib/maker/` nomini il tetto (158 file controllati).

**E il caso degenere: concorrenza misurata ZERO** (8 agosto 2026 sera — in `main`, già in servizio).
`share = size/(size+cQ)` vale **1** quando la concorrenza in banda vale 0, e il knapsack massimizza: un
book vuoto era l'occasione migliore che potesse leggere, mentre `realisticEstimate` su quel caso si
**rifiuta** di stimare (`empty-book`). Due meccanismi, con lo stesso interruttore:
- **Lo zero è un fatto o un buco?** Si può sapere: `agent34` scrive la profondità in banda come `null`
  quando banda, mid o book mancano, e come **numero solo dopo aver camminato ogni ordine** dentro la
  banda. Uno **0** è «ho guardato e non c'era nessuno»; un dato mancante è `null` e non diventa mai
  zero. `profonditaVerificata(rows)` classifica `misurata` / `vuota-verificata` (mediana zero con ≥10
  campioni misurati e ≥1 zero su book **fresco**, `src:'ws'`) / `non-verificata`. Sul terzo caso
  **l'obiettivo si astiene** — niente punteggio, e neanche un fattore più basso inventato.
- **Quanto piano può reggere un deserto verificato?** `capVuotiFrac = 0,30`: i mercati con book vuoto
  verificato possono valere insieme al più il 30% del lordo pesato del piano; oltre, si tengono i
  migliori e gli altri restano fuori col motivo, e il DP rigira (lo stesso idioma del filtro orizzonte).
  Serve perché **un tetto di capitale non basterebbe**: con `cQ = 0` la quota vale 1 a qualunque size,
  quindi il lordo è piatto e il knapsack dà già il minimo — l'unica leva è quanti ne entrano.
  0,30 e non altro: il tetto per *mercato* è 0,20 sul *capitale*, e questo vincola il *lordo modellato*
  di una *categoria*, quindi è deliberatamente più largo — ma resta sotto la metà.
- **Misurato**: su cinque finestre (dal vivo a −36h) i mercati a profondità mediana zero sono 0-2 e
  sono **tutti verificati** — lo zero non verificato non si presenta mai, quindi il primo meccanismo è
  protettivo e non correttivo. Sul piano vero ($660): 1 mercato su 6 è un deserto verificato e pesa il
  **25,9%** del lordo pesato, sotto il tetto ⇒ **il piano non cambia**. I due meccanismi sono tarati
  perché la situazione di oggi passi e quella delle 20:00 (73% su un mercato solo) no.

**La corsia calda si ordina sull'obiettivo del knapsack** (`collector-priority.js`, 8 agosto 2026 —
in `main`, non ancora nei processi). L'unione mobile con isteresi c'era; la **graduatoria** dei
quasi-vincitori no: era ordinata per `bestNetPerDay`, che `calcNetPerDay` annulla quando nessun fill è
stato osservato. Giusto per un numero da leggere, sbagliato per una graduatoria — escludeva i mercati
*silenziosi*, cioè quelli su cui un maker vuole stare. Misurato: **412 delle 755 righe future
esaminate erano fuori graduatoria**, quindi irraggiungibili da qualunque K. Ora si ordina su
`bestObiettivoPerDay` e scendono a 142/666 (storico) e **0/214** (vivo). I tre numeri, rimisurati:
**TOP_K 30 → 15** (vivo: K=10 copre 214/214 righe, profondità massima 9; storico: K=15 copre il 98,5%
delle coperibili e oltre non guadagna nulla fino a 50+), **RETENTION 12h confermato** (ritorni
osservati a 3,01h · 6,01h · 8,01h), **MAX_MARKETS 40 → 30** (righe 7-9 + K 15 = 24, restano 6 slot;
il feed sta a **112 mercati su 125** di `TOTAL_MARKET_CAP`, quindi ogni slot chiesto è un mercato del
board in meno). Misura riproducibile: `node scripts/misura-ricambio-candidati.js` (sola lettura).

**Il capitale fermo non aspetta sei ore** (`lib/maker/trigger-capitale-fermo.js`, 8 agosto 2026 — in
`main`, **non ancora nel processo**: serve un riavvio di agent41, §5 punto 17). Il ciclo fisso resta
identico e continua a girare ogni 6 h; accanto c'è un **mini-ciclo** che ogni **120 s** guarda una cosa
sola: quanto collaterale è libero.
- **La misura**: il saldo pUSD. Su questo venue un ordine BUY a riposo *immobilizza* il collaterale,
  quindi il saldo libero **è** per costruzione il capitale non allocato — dedurlo sottraendo gli ordini
  sarebbe una seconda lettura che può divergere dalla prima.
- **Soglia $50** (decisa dall'operatore): con quella cifra c'è spazio per un ordine intero, dato che il
  nozionale mediano dei 21 maker di riferimento è ~$34.
- **Cadenza 120 s**: la cache del saldo ha TTL 45 s, quindi sotto i 45 s si rileggerebbe lo stesso
  valore. 120 s sono 2,7 TTL e costano una chiamata al dashboard locale. La lettura del **venue** non
  avviene a ogni giro, solo quando la soglia è già superata.
- **Non ricalcola il piano** — è tutto il punto: quel calcolo costa ~52 s e 687 MB. Legge l'**ultimo
  piano salvato** (`data/realloc-ultimo-piano.json`, scritto dal ciclo fisso, ridotto ai soli campi che
  servono a costruire le due gambe).
- **Dove manda il capitale**: sul mercato dove il piano aveva messo capitale e adesso ne ha meno del
  previsto — la definizione operativa di «capitale liberato». Riporta il portafoglio *verso* il piano
  invece di inventarne uno nuovo.
- **Le sei cose che non può fare**, strutturali: non cancella niente (ed è la risposta completa a «e gli
  ordini manuali?» — non tocca **nessun** ordine esistente); non piazza a bot FERMO; non si sovrappone
  al ciclo fisso (`inCorso` condiviso, rilasciato in `finally`); non piazza su saldo illeggibile né su
  board più vecchio di 20 min; non forza (spazio sotto $34 o size sotto il minimo del venue ⇒ il
  capitale resta liquido).
- **Audit distinto**: `reason: 'capital-idle-trigger'`, per contare nel tempo quanto spesso scatta e
  quanto capitale rimette al lavoro senza confonderlo coi cicli fissi.
- **Si guarda lavorare senza toccare capitale**: `node scripts/simula-trigger-capitale.js 120` esegue la
  funzione vera con la sola corsia di piazzamento sostituita da un registratore.
- **Una riga malformata non ferma più la ricerca** (8 agosto 2026, sera — in `main`, **serve il riavvio
  di agent41**, §5 punto 21). `scegliMercato` accetta un predicato iniettato `gambeCostruibili`: una
  riga le cui due gambe non si costruiscono viene **saltata** con il motivo a verbale in `esaminate`,
  e la scelta passa alla successiva della graduatoria — esattamente come già faceva per lo spazio
  insufficiente o le share sotto il minimo. Il predicato è iniettato e non importato, così il modulo
  resta puro e la costruzione delle gambe continua a vivere in un posto solo; un predicato che
  **esplode** vale «non costruibile», mai un via libera. Chi non lo passa ha il comportamento di prima.

**La truthiness di `find` non è un test di esistenza** (`lib/rewards/plan-to-orders.js`, 8 agosto 2026
sera). `gambeDiUnaRiga` proteggeva la gamba nulla così:

```js
const impossibile = gambe.find((g) => !g || g.placeable !== true);   // ← restituisce l'ELEMENTO
if (impossibile) { … }                                               // ← e l'elemento È null
```

`planQuotes` torna con `yes:null, no:null` quando mid, offset o **tick** non sono leggibili
(`mm-quote-math.js:32-34`). In quel caso `find` trovava la gamba nulla, restituiva `null`, e la guardia
**non scattava** — ingannata esattamente dal caso per cui era stata scritta. Due righe sotto,
`g.inBand` esplodeva. Ora è `findIndex` con la sentinella `-1`, che non può collidere con un elemento
legittimo. **Regola generale**: in un array che può contenere valori falsy, «esiste un elemento che…»
si scrive con `findIndex` o `some`, mai con la truthiness di `find`.

**Il pannello non si accoda più a se stesso.** `placeManualOrder`, quando il chiamante non passa
`ownOrders`, li **legge** dal venue e tiene solo il lato che sta quotando (per token id). Prima solo
agent40 li passava: tutti gli altri percorsi con `inCoda:true` mandavano una lista vuota, e dal secondo
ordine in poi il «concorrente» da battere eravamo noi — un tick per ogni nostro ordine davanti.

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

**STATO OPERATIVO ALL'8 AGOSTO 2026, 12:07:55 UTC: IL BOT È SU AVVIA.** L'operatore ha premuto il
bottone dalla tab «Mercati ottimizzati»: `data/maker-bot-enabled.json` esiste e dice `enabled:true`,
`by:"operatore · tab Mercati"`, `reason:"AVVIA dalla dashboard"`. **Da questo momento il prossimo ciclo
di agent41 piazza ordini VERI** — non è più un'anteprima. La rampa è a `0/5 mercati aperti nelle prime
24h` (scade alle 12:07:55Z del 9 agosto).

**Ma alle 12:45 UTC non era ancora stato piazzato niente, e la ragione è strutturale.** L'ultimo ciclo
completo è delle `2026-08-08T10:16:26Z` — *prima* dell'AVVIA e prima che agent41 ripartisse (11:24) col
codice del trigger. Premere AVVIA **non anticipa il ciclo**: `prossimoRitardo()` conta dalle sei ore
dell'ultimo `lastRunAt` su disco, quindi il prossimo giro è alle **16:16:26Z**. E il trigger a capitale
fermo, che esiste proprio per non aspettare, **non può coprire il primo avvio**: scatta regolarmente
(`saldo $646,26 ≥ soglia $50`, ogni 10 min per il cooldown) ma esce al passo 1 con «nessun piano
salvato finora: il primo ciclo completo lo scrive» — `data/realloc-ultimo-piano.json` non esiste ancora.
Vedi §5 punto 19.

**Guardiano delle perdite: attivo.** Il processo gira dalle 21:27:31 del 7 agosto 2026 con
baseline **$660,56** in `data/guardian-baseline.json` (sopravvive ai riavvii, si azzera solo
cancellando il file). Soglie lette da `.env` a ogni giro: `GUARDIAN_LOSS_PCT=5`,
`GUARDIAN_LOSS_ABS=30`. Nessuno scatto: `data/guardian-state.json` non esiste.

**Confronto stima / consuntivo del venue: infrastruttura pronta, dato ancora assente.**
`lib/maker/confronto-reward.js` (agent40, 23:55 e 00:20/00:40/01:00 UTC) più
`lib/maker/reward-reale.js`, rotta `/api/maker/confronto-reward`. L'8 agosto 2026 il percorso
interrogato è stato **corretto**: `/rewards/user` e `/rewards/user/total` rispondono **401** con le
nostre credenziali L2, **`/rewards/user/markets?date=…` risponde 200** e dà anche la scomposizione per
mercato (paginato, `next_cursor`; la firma HMAC va sul percorso *completo*, query inclusa).
**Ma quel 200 non è un consuntivo**: nella lettura reale portava `maker_address` a **zero su tutte e
5.065 le righe** e `earnings: 0` ovunque — è il catalogo dei mercati premianti, non l'estratto conto
di questo maker. Una lettura vale quindi solo se **almeno una riga è attribuita** a un nostro
indirizzo (EOA o funder); altrimenti `disponibile:false`, `attribuito:false`, motivo per esteso.
Il verdetto sulla deriva (`divergenza`) è **mediana ≥30% su ≥5 giornate confrontabili e ≥80% nello
stesso verso**, viaggia nel file, nella rotta e nel log di agent40 quando *cambia*; `dati-insufficienti`
è un terzo esito e non vuol dire «va bene». **Non corregge niente** per scelta.

**LA FONTE CHE ATTRIBUISCE DAVVERO, trovata l'8 agosto sera.** Il CLOB non attribuisce nulla, e la
ragione non era l'endpoint: era l'**identità**. Le credenziali L2 sono dell'EOA che firma, ma su un
deposit-wallet ERC-1271 il maker è il **funder**. Il registro attività **pubblico** è keyed sul funder:

```
GET https://data-api.polymarket.com/activity?user=<funder>&type=REWARD
```

Sul conto di questa macchina c'è **un** pagamento: **$1,3042** alle 00:00:03 del 7 agosto,
tx `0x4333636f…3be` — il reward della giornata del **6 agosto**, per cui la stima diceva **$3,09**.
**Primo confronto stima↔consuntivo mai riuscito: sovrastima del 136,93%.** Il 401 lo teneva invisibile.
- La fonte è **senza credenziali** — rafforza la proprietà del modulo: non ha nemmeno le chiavi L2.
- **Non porta il mercato** (`conditionId` vuoto): la scomposizione resta non disponibile e viene
  dichiarata, non inventata dividendo il totale.
- Un pagamento appartiene alla giornata UTC appena chiusa (`giornoDiCompetenza`, 6 ore di margine
  dichiarate — assunzione su una sola osservazione).
- **Uno zero vale zero solo se** il registro contiene almeno un nostro pagamento *e* la finestra di
  quella giornata è chiusa. Altrimenti resta «non lo so».
Il percorso CLOB è diventato `leggiRewardDaMercati`, fonte **secondaria e spenta** (≈51 richieste a
notte per un catalogo non attribuito), riaccendibile con `conScomposizione`.

**Altri stati letti:** kill-switch **non attivo** (`killed:false`); arming **disarmato**
(`armed:false`, `disarmReason:"kill-switch"`, del 6 agosto, mai riarmato); `MANUAL_ORDER_PLACEMENT=send`;
`MAKER_FUNDING_APPROVED=true` su agent35/40/41 (attestazione umana, non un armamento).

---

## 5 · QUESTIONI APERTE

Lista viva. Solo voci con evidenza reale nel codice, nei commit o nei file di stato.

1. **~~Il bot non è mai stato avviato~~ — CHIUSO alle 12:07:55 UTC dell'8 agosto 2026.** L'operatore ha
   premuto AVVIA dalla dashboard. `statoBot()` risponde `enabled:true`, `by:"operatore · tab Mercati"`.
   Vedi §4 per lo stato completo e §5 punto 19 per il motivo per cui questo, da solo, non ha ancora
   prodotto ordini. (Era già chiuso il resto del punto: il codice del guardiano è in git dal 7 agosto
   — `dbba34e` — e i residui che un suo test aveva lasciato sullo stato vero sono stati cancellati la
   sera stessa; la versione attuale del test inietta `impostaBot` e `registraCancellazione`.)
2. **La copertura dichiarata di FERMA non corrisponde al runtime di agent35.** L'header di
   `agent43-guardian.js` afferma che agent35 «è fermato a monte da `MAKER_MODE=off` e non può
   piazzare». Il processo in esecuzione ha invece `MAKER_MODE=live-min` e `MAKER_PLACEMENT=send`
   (letto da `/proc/<pid>/environ`; è ciò che `ecosystem.config.js:620` dichiara). Oggi non piazza per
   un'altra ragione — `manual mode active` sul mercato in questione (`data/maker-manual-mode.json`) —
   che è uno stato per-mercato, non un blocco globale. Il limite reale resta quello documentato:
   **FERMA copre agent41, non agent35 né il pannello manuale**, e non esiste un punto in cui bloccare
   i piazzamenti nuovi senza bloccare anche le uscite. Da correggere: il commento, o la copertura.
3. **`REALLOC_SCHEDULER_DRY_RUN=1` resta nell'ambiente del processo agent41 — PER DECISIONE
   DELL'OPERATORE (8 agosto 2026), e un riavvio non può toglierla.** Inerte: nessuna riga di codice la
   legge, e `lib/maker/gestione-manuale-nel-flusso.test.js` fallisce se ricompare nel codice.

   **DOVE VIVE DAVVERO — misurato l'8 agosto 2026, ~07:30 UTC, e smentisce quello che questo punto
   diceva prima.** Non è nel demone pm2 (`/proc/<pid-demone>/environ`: assente), non è in
   `~/.pm2/dump.pm2` (nessuna delle 41 app la porta), non è in `.env` né in `ecosystem.config.js` —
   in questi due compare solo dentro commenti storici. Vive nella **descrizione in memoria che pm2
   tiene del processo** (`pm2_env.REALLOC_SCHEDULER_DRY_RUN = 1`), fissata al primo avvio da una shell
   che ce l'aveva. Da lì un `resurrect` non la rimetterebbe: il dump è pulito.

   **PERCHÉ NESSUN `restart` LA TOGLIE, in nessuna forma.** `--update-env` **fonde**, non sostituisce:
   aggiunge e aggiorna le chiavi che trova, e non cancella mai quelle che non ci sono più. Una chiave
   entrata una volta nella descrizione sopravvive a ogni riavvio. Provato: riavvio eseguito da una
   shell in cui la variabile era dimostrabilmente assente, e dopo il riavvio era ancora lì.

   **IL COMANDO CHE QUESTO PUNTO DOCUMENTAVA ERA SBAGLIATO E PERICOLOSO.** Era
   `env -u REALLOC_SCHEDULER_DRY_RUN pm2 restart … --update-env`. Non solo non funziona: su questa
   macchina avrebbe **perso 63 variabili**, fra cui `DATABASE_URL`, `ADMIN_ACCESS_SECRET`,
   `POLYGON_RPC_URL`, `MAKER_FUNDER_ADDRESS`, `MAKER_SIGNATURE_TYPE`, `MANUAL_ORDER_PLACEMENT` — tutte
   ereditate e **nessuna presente nel demone**. agent41 **non ha il caricatore di `.env`** (lo dice il
   blocco `env` in `ecosystem.config.js`), quindi le avrebbe perse davvero.

   **LA TECNICA GIUSTA PER RIAVVIARE agent41 SENZA PERDERE L'AMBIENTE** (usata l'8 agosto, verificata:
   102 → 102 variabili, zero chiavi perse). Si ricostruisce l'ambiente VERO dal processo vivo:
   ```bash
   PID=$(pm2 jlist | node -e "…")           # mai da pgrep — vedi il punto 8
   while IFS= read -r -d '' kv; do
     k=${kv%%=*}
     case "$k" in
       NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|PM2_JSON_PROCESSING|PM2_USAGE|NODE_APP_INSTANCE) continue ;;
     esac
     case "$k" in [A-Z]*) export "$kv" ;; esac   # solo MAIUSCOLE: scarta la contabilità interna di pm2
   done < /proc/$PID/environ
   pm2 restart agents/ecosystem.config.js --only agent41-realloc-scheduler --update-env && pm2 save
   ```
   I due filtri non sono cosmetici: `NODE_CHANNEL_FD` è il canale IPC del processo **vecchio** ed
   ereditarlo è l'unico modo di rompere davvero il riavvio; il filtro sulle maiuscole toglie le chiavi
   di servizio di pm2 (`pm_id`, `exec_mode`, `name`, `status`, `cwd`, `script`…) finite nell'ambiente.

   **L'unica rimozione possibile sarebbe `pm2 delete` + `pm2 start`** (dalla shell qui sopra, perché
   il demone non ha le variabili critiche). L'operatore ha deciso l'8 agosto 2026 di **non farlo**: la
   variabile è inerte, il dump è pulito, e un `delete` azzera il contatore dei riavvii e lascia agent41
   giù se lo `start` fallisce. Questo punto resta aperto come **nota**, non come lavoro da fare.
4. **L'header di `lib/maker/strategia-merge.js` è invecchiato.** Elenca ancora quattro ragioni per cui
   il merge «NON è eseguibile dallo stack attuale»; il relayer gasless ne ha tolte tre e
   `ctf-relayer.js` la quarta, e il ciclo è stato eseguito davvero il 7 agosto 2026 (commit `95aa634`
   e `d21669d`). Il manuale operativo v2 è già stato corretto; questo file no.
5. **Arming disarmato da un kill ormai revocato.** `data/maker-arming.json` è `armed:false` con
   `disarmReason:"kill-switch"` del 6 agosto 22:13; il kill è stato revocato il 7 agosto («nuovo
   interruttore AVVIA/FERMA: il kill torna a essere lo STOP di emergenza»), ma l'arming non è mai
   stato ripreso. Da chiarire se è voluto.
6. **`data/maker-bot-enabled.json` e `data/cancellazioni-di-emergenza.json` non sono coperti da
   `.gitignore`.** **Non è più teorico: dalle 12:07:55 dell'8 agosto `data/maker-bot-enabled.json`
   esiste e compare come `??` in `git status`** — esattamente come questo punto prevedeva. Va aggiunto
   all'ignore *prima* che qualcuno lo committi: versionato, un `git checkout` può spostare
   l'interruttore del capitale. Tutti gli altri
   file dello stesso tipo — comprese baseline e latch del guardiano — sono ignorati per una ragione
   esplicita: descrivono *questa* macchina in *questo* momento, e versionare l'interruttore
   AVVIA/FERMA significa che un `git checkout` può spostarlo. Da aggiungere all'ignore.
7. **~~Il codice della sera del 7 agosto non è attivo~~ — CHIUSO alle 23:57 UTC del 7 agosto 2026.**
   Il tetto di concentrazione al 20% era stato deployato alle ~22:30–22:41; le fasi 1–8 sono state
   attivate con un secondo giro di riavvii autorizzati esplicitamente in chat («Riavvia agent35,
   agent40, agent41 e dashboard»):

   | Processo | restart | Cosa è entrato in servizio | Verifica |
   |---|---|---|---|
   | `agent35-maker` | 24 → 25 | rotaia `end-of-scale` in `risk-rails` | env intatto (`MAKER_MODE=live-min`, `MAKER_PLACEMENT=send`, funding approvato), log puliti |
   | `agent40-manual-reprice` | 49 → 50 | cadenza adattiva, ordini propri in coda, fine scala | soglie invariate all'avvio (`hysteresis 1 tick`, `confirm 2 samples`) — la cadenza non le tocca |
   | `agent41-realloc-scheduler` | 29 → 30 | timbro `origine: 'auto'`, `leggiOrigini` nel reset | «tetto per mercato 20% · il bot è FERMO» |
   | `dashboard` | 167 → 168 | pannello «Mid vivo», rotta SSE `/api/maker/live-mid` | http 200; la rotta risponde 401 come `board` e `status` (stesso gate operatore); «Mid vivo» nel chunk servito |

   Log di errore vuoti su tutti e tre gli agent; le righe rosse del dashboard sono le vecchie delle
   22:39 e il contatore dei riavvii non sale.
   Nota operativa registrata: **verificare `.next/prerender-manifest.json` prima di riavviare il
   dashboard**. Una build incompleta ne produce solo la variante `.js`, e il processo entra in crash
   loop con `ENOENT` (successo il 7 agosto: 19 riavvii automatici prima che una build nuova lo
   risolvesse). Verificato prima di questo riavvio, ed è andato liscio.

8. **`pgrep -f <nome-processo>` non è affidabile in questa sessione.** Il comando che lo esegue contiene
   il nome cercato, quindi `pgrep` trova anche la propria shell e `head -1` può restituire quella: il
   7 agosto è costato due riavvii inutili di agent41 e una diagnosi sbagliata («l'ambiente è andato
   perso», mentre erano 102 variabili tutte al loro posto). Per l'ambiente di un processo pm2 si prende
   il pid da `pm2 jlist` e si legge `/proc/<pid>/environ`.

9. **~~Il codice dell'8 agosto non è nei processi~~ — CHIUSO alle 07:22 UTC dell'8 agosto 2026.**
   Riavvii autorizzati esplicitamente in chat («Riavvia agent41, agent40, dashboard e agent34»).

   | Processo | restart | Cosa è entrato in servizio | Verifica |
   |---|---|---|---|
   | `agent41-realloc-scheduler` | 31 → 33 (due riavvii: uno col resto della flotta, uno per il tentativo di togliere `REALLOC_SCHEDULER_DRY_RUN` — vedi punto 3) | punteggio di posizione nella selezione + graduatoria e K/N della corsia calda (è chi *scrive* `collector-priority.json`) | env intatto: 102 variabili, `MAKER_FUNDING_APPROVED=true`, `MAKER_MODE=off`; «tetto per mercato 20% · il bot è FERMO» |
   | `agent40-manual-reprice` | 50 → 51 | percorso corretto del consuntivo, guardia di attribuzione, scomposizione per mercato, avviso di deriva | cadenza adattiva regolare, log di errore vuoto |
   | `agent34-clob-ws` | 15 → 16 | `MAX_MARKETS=30` in `readCollectorPriority` | risottoscrizione pulita, 107 mercati / 214 asset |
   | `dashboard` | 168 → 169 | `divergenza` e `soglie` su `/api/maker/confronto-reward` | http 200 sulla root; la rotta risponde 401 come `board` e `status` (stesso gate operatore); «divergenza» nel chunk servito |

   Log di errore vuoti su tutti e tre gli agent; le righe rosse del `dashboard` sono le vecchie delle
   03:36 e nessun contatore sale da solo (verificato a +3 minuti: 169/16/51/32, tutti +1 rispetto al
   prima; agent41 è poi passato a 33 per il secondo riavvio, voluto, del punto 3).
   `.next/prerender-manifest.json` verificato PRIMA del riavvio del dashboard (nota del punto 7).

   **Effetto immediato, misurato:** `collector-priority.json` è ancora quello scritto alle 04:16 dal
   codice vecchio (**40 mercati**), ma agent34 adesso ne legge **30** — il tetto nuovo morde già in
   lettura. Il file tornerà nativamente a ≤30 al prossimo ciclo di agent41, **fra ~175 minuti**
   (~10:15 UTC): fino ad allora K=15 vive solo in lettura, non ancora in scrittura.

   Già vivo anche senza riavvio, e resta un fatto utile: il pannello «Ottimizza». `/api/rewards/allocate`
   non importa l'allocatore nel bundle — esegue `planFromCollection` in un processo node NUOVO a ogni
   chiamata, quindi legge sempre il codice su disco.

10. **~~L'obiettivo non sente il tetto di credibilità~~ — CHIUSO l'8 agosto 2026, sera.**
    `maxCredibleShare` è dentro l'obiettivo del knapsack (`useCredibleShareCap`), riusando le funzioni
    **estratte** da `realistic-estimate.js` invece di riscriverle; l'estrazione è provata neutra sulla
    stima realistica (hash identico su 4.320 combinazioni). Nel farlo è emerso e si è corretto un
    secondo difetto: il fattore di posizione non è `S` ma `S·size/(S·size+cQ)` diviso la quota-ceiling.
    Vedi §4. Misurato su sei finestre: il realistico non peggiora mai e migliora fino a **+11,2%**.

11. **~~Il confronto non ha ancora un dato~~ — CHIUSO l'8 agosto 2026, sera.** La fonte che attribuisce
    è il registro attività pubblico, keyed sul **funder** (le credenziali L2 sono dell'EOA: era un
    problema di identità, non di endpoint). Prima misura reale: stima $3,09 contro consuntivo
    **$1,3042** per il 6 agosto, **sovrastima del 136,93%**, con il `transactionHash` nel registro.
    Restano **4 giornate** prima che `divergenza` possa pronunciarsi (ne servono 5 confrontabili).
    Vedi §4.

12. **I cinque test rossi: diagnosi fatta, correzione da decidere.** Il report è in
    `docs/indagine-cinque-test-rossi.md` (8 agosto 2026). **Nessuno dei cinque segnala un bug di
    produzione**, e in particolare **il sospetto bug di unità di misura su `MIN_HORIZON_DAYS` non
    esiste**: la conversione giorni→minuti è corretta, è cambiato il *valore* (2 → 0,25 g) con il
    commit `0a0a845` e con la motivazione misurata (i 21 maker entrano su mercati con vita mediana
    0,44 g; il pavimento a 2 giorni escludeva l'archetipo). Tutti e cinque sono `(a)`: test o
    rilevatori rimasti indietro, o fixture che non allestiscono il caso che vogliono provare —
    `risk-classifier` e `scadenza-ereditata` hanno la **stessa** causa, `cancellazione-riconosciuta`
    interroga la produzione e trova un campione vuoto (0 `cancelOrder` su 22.602 righe di polling),
    `dipendenze-collegate` è un falso positivo su un ternario andato a capo, `scaduto-senza-rinnovo` ha
    una fixture il cui ordine viene riprezzato al primo giro.
    **Una cosa da correggere c'è, ed è un commento:** `lib/maker/risk-classifier.js:26` dichiara
    `MIN_HORIZON_DAYS = 2` mentre il valore importato è 0,25 — su un modulo la cui intestazione promette
    che «la soglia usata e la soglia scritta non possano raccontare due numeri diversi». Non corretto:
    va deciso insieme al test, e scritto in modo che non possa invecchiare di nuovo.

13. **~~Il caso degenere della concorrenza misurata ZERO~~ — CHIUSO l'8 agosto 2026, sera.** Vedi §4:
    la distinzione fra deserto misurato e buco è ricostruibile e implementata, e un tetto di categoria
    al 30% impedisce che un deserto verificato sia la maggioranza del piano. Misurato: lo zero non
    verificato non si presenta mai su cinque finestre, e sul piano di adesso la categoria pesa il 25,9%
    — sotto il tetto, quindi il piano non cambia.

14. **Il lavoro sull'allocatore NON richiede riavvii, e vale la pena saperlo una volta per tutte.**
    Nessuno dei tre file toccati (`lib/rewards/allocator.js`, `lib/rewards/realistic-estimate.js`,
    `scripts/rewards-replay/lib/allocate.js`) vive dentro un processo pm2 di lunga durata: **entrambi**
    i percorsi che calcolano un piano lo fanno in un processo node nuovo che rilegge il codice da disco.
    - `/api/rewards/allocate` → `execFile('node', ['-e', RUNNER])` (pannello «Ottimizza»);
    - `agent41-realloc-scheduler` → `RUNNER_PIANO`, riga 225, un figlio per ciclo. Non è per il codice
      caldo: è la correzione del 4 agosto 2026, perché il piano porta il processo da 41 MB a 687 MB
      contro un tetto pm2 di 400 MB, e pm2 lo fermava **nel mezzo del ciclo**.
    Verificato empiricamente eseguendo il runner esatto di agent41: risponde `tettoCredibilita: true`,
    `mercatiCapati: 4`. Quindi il lavoro è in servizio senza toccare niente.

    **TRAPPOLA REGISTRATA, e ci sono cascato:** un walker del grafo dei `require` che cerchi
    `require('...')` con una regex trova anche i `require` **dentro le stringhe** — e `RUNNER_PIANO` è
    esattamente una stringa che contiene `require(".../lib/rewards/allocator")`. Il walker mi ha
    dichiarato che agent41 importa l'allocatore in-process, e non è vero: c'è solo quella stringa. Chi
    scrive un test che cammina i `require` (ce ne sono già tre in questo repo) tenga conto che una
    stringa non è un import — e che qui la differenza è fra «serve un riavvio» e «non serve».

15. **~~La rinomina non è ancora in pm2~~ — CHIUSO alle 09:15:41 UTC dell'8 agosto 2026.** Eseguito
    dall'operatore: `agent42-guardian` (pm_id 43) fermato, `agent43-guardian` (pm_id 44) avviato al suo
    posto. Verificato: **89 variabili d'ambiente, tutte e quattro le critiche presenti**
    (`DATABASE_URL`, `KEY_CUSTODY_MASTER`, `POLYGON_RPC_URL`, `MAKER_FUNDER_ADDRESS`), contatore dei
    riavvii a 0 come previsto, e soprattutto **il guardiano legge il capitale**: «ok — PnL +8,47 USD
    (+1,282%) · baseline $660,56 → $669,03 · soglie −30 USD / −5%». Era il rischio del punto: un
    guardiano senza quelle variabili non scatta mai, e il log dimostra che non è il caso.
    Alle 09:16:08 è stato riavviato anche `agent40-manual-reprice` (51 → 52, 95 variabili, 4/4
    critiche), quindi da stanotte il consuntivo reward usa la fonte nuova in automatico.

    *(Il comando che era documentato qui, con la ricostruzione dell'ambiente dal processo vivo, resta
    valido e riutilizzabile: è nel punto 3.)*

16. **`agent44-audit-scoperta` esiste, gira alle 03:07 UTC, e la sua coda va guardata.** Prima
    scansione: **17 reperti aperti, nessuno ad alta severità**. Vale la pena sapere cosa ha trovato al
    primo colpo, perché due cose non le sapevamo:
    - il commento di `lib/maker/risk-classifier.js:26` fermo a `MIN_HORIZON_DAYS = 2` — lo stesso che
      §5 punto 12 registra come «da correggere»: il rilevatore lo trova da solo;
    - **tre flag di `.env` che nessuna riga legge più**: `CAPITAL_USD`, `OFFSET_TICKS`, `MAX_MARKETS`
      (verificati a mano: zero occorrenze di `process.env.<nome>` in tutto il repo);
    - **tre test che `node` non riesce nemmeno ad avviare** — `lib/leg-order.test.js` e i due in
      `lib/venues/__tests__/`: sono test in JS per moduli **TypeScript**, quindi `require('./leg-order')`
      non si risolve. Non sono rossi: non sono mai partiti, ed è una copertura che si credeva di avere.
      Sono in aggiunta ai cinque rossi noti del punto 12, che restano cinque.
    Si guarda con **`node scripts/vedi-audit.js`** (o `cat data/audit-coda.md`). La coda è ignorata da
    git: descrive questo albero di lavoro su questa macchina, e versionarla farebbe ripartire da zero
    l'età dei problemi aperti.

    **Il comando, e i due motivi per cui non è quello ovvio:**
    ```bash
    # 1 · l'ambiente VERO del processo vivo (95 variabili), meno le chiavi di servizio di pm2.
    #     Senza questo passo il guardiano perde DATABASE_URL, KEY_CUSTODY_MASTER, POLYGON_RPC_URL e
    #     MAKER_FUNDER_ADDRESS — nessuna delle quali sta nel suo blocco `env` e nessuna nel demone —
    #     e un guardiano che non sa leggere il capitale è un guardiano che non scatta mai.
    PID=$(pm2 jlist | node -e "…")          # mai da pgrep, vedi il punto 8
    while IFS= read -r -d '' kv; do
      k=${kv%%=*}
      case "$k" in NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|PM2_JSON_PROCESSING|PM2_USAGE|NODE_APP_INSTANCE) continue ;; esac
      case "$k" in [A-Z]*) export "$kv" ;; esac
    done < /proc/$PID/environ
    # 2 · e solo adesso
    pm2 delete agent42-guardian && pm2 start agents/ecosystem.config.js --only agent43-guardian && pm2 save
    ```
    **Cosa NON si perde:** la memoria del guardiano è nei file, non nel nome —
    `data/guardian-baseline.json` (il punto zero, $660,56) e `data/guardian-state.json` (la latch)
    sopravvivono, quindi il guardiano riparte dallo stesso baseline e non si «riarma» da solo.
    **Cosa si perde:** il contatore dei riavvii riparte da zero, e fra il `delete` e lo `start` il
    capitale resta per qualche secondo senza guardiano. Oggi l'esposizione è nulla — il bot è FERMO e
    l'ultimo ciclo di agent41 ha piazzato 0 ordini — ma va detto prima, non dopo.
    **Cosa non instrada nulla:** la chiave di battito è cambiata insieme al nome, e nessuno la legge —
    `agent-monitor` non sorveglia questo processo (non è in `WATCHED_AGENTS_RAW`) e agent37 guarda i
    battiti dei motori. Il campo `by` dei referti passa al nome nuovo solo per i referti futuri: quelli
    storici restano col vecchio, ed è giusto, dicono chi li ha scritti.

17. **~~Il trigger a capitale fermo non è nel processo~~ — CHIUSO alle ~11:24 UTC dell'8 agosto 2026.**
    agent41 riavviato dall'operatore (restart 33 → 34); il log all'avvio dice «trigger capitale fermo
    ACCESO — soglia $50, controllo ogni 120s · non cancella niente, non ricalcola il piano».
    Il primo giro ha risposto come previsto: `data/realloc-ultimo-piano.json` lo scrive il primo ciclo
    completo, e fino ad allora il mini-ciclo non piazza. E comunque il bot è FERMO (punto 1).
    **Una riga di quel file è cambiata DOPO il riavvio** e aspetta il prossimo: `controlloCapitaleFermo`
    guardava il saldo *prima* di guardare se il bot è avviato — una HTTP più una lettura on-chain ogni
    120 s per una decisione già presa, ~720 al giorno a vuoto. Adesso i due cancelli gratuiti vengono
    prima. **Non urgente**: costa chiamate, non correttezza.

18. **~~La correzione del consumo di agent40 è in `main` ma non nel processo~~ — CHIUSO alle 12:07:06
    UTC dell'8 agosto 2026.** Riavvio eseguito dall'operatore (restart 52 → 53), dopo il commit `8f23d65`
    delle 12:02:15. **Misura di conferma:** agent40 sta ora fra **7,8% e 12,9%** di CPU, contro il 110%
    di prima. Il resto di questo punto resta come registro di cosa è stato corretto.

    Due difetti nello stesso percorso, entrambi corretti e misurati:
    - il **seek** in `lib/rewards/velocita-mercato.leggiCoda` partiva da `size − 128 MB` (tetto
      dimensionato per sei ore) invece che dalla finestra chiesta: con il giornale a 77 MB quel conto
      dà zero, quindi si leggeva tutto dall'inizio anche per quindici minuti. **524 ms → 32 ms**;
    - `cadenzaPer` chiamava `leggiFinestraMercato` **una volta per mercato**, e ogni chiamata costruisce
      la mappa di *tutti* i mercati per proiettarne uno. Ora c'è `leggiFinestraTutti`: una lettura per
      ciclo. **Il gate cadenza di un ciclo intero: 6.812 ms → 29-36 ms**, cioè da **136% a 0,6%** di un
      core, con 3,75 MB letti invece di 77.
    - e il test anti-regressione ha trovato un terzo punto che la diagnosi non aveva visto:
      `liquiditaMedia` è un'altra lettura per mercato, con finestra da **240 minuti**, sul percorso di
      riprezzo. Adesso passa da una mappa **pigra** — costa zero nei giri in cui nessuno riprezza.

    **Il risultato non cambia**, ed è provato: firma SHA-256 identica prima e dopo su 169 righe (13
    mercati × finestre 15/60/240 min, più `leggiVelocita` a 6 h su 130 mercati), calcolata su una copia
    congelata del giornale vero.

    **Il comando, ed è quello semplice:**
    ```bash
    pm2 restart agent40-manual-reprice
    ```
    Niente ricostruzione dell'ambiente come per agent41: agent40 **ha** il proprio caricatore di `.env`
    (righe 56-62), e un `restart` per nome non tocca la descrizione in memoria di pm2 — verificato dal
    riavvio delle 09:16, dopo il quale il processo aveva 95 variabili e tutte e quattro le critiche.

    **Perché contava anche a bot FERMO:** finché non si riavviava, un core su due restava occupato e il
    costo **cresceva durante la giornata** (il giornale cresce ~6,7 MB/h e si azzera a mezzanotte).
    Verso le 19:00 il file supera i 128 MB e il ciclo da 5 s avrebbe cominciato a slittare — cioè il
    motore che tiene gli ordini dentro la banda sarebbe arrivato tardi. Con il bot ora su AVVIA il
    riavvio è arrivato appena in tempo.

19. **IL PRIMO AVVIO NON HA UN INNESCO, e nessuno dei due percorsi lo copre** (trovato l'8 agosto 2026,
    ~12:30 UTC, a bot già su AVVIA e con capitale reale collegato). Non è un guasto: è un buco fra due
    meccanismi che funzionano entrambi.
    - **Il ciclo fisso non si sposta.** `prossimoRitardo()` legge `lastRunAt` da disco: premere AVVIA
      non lo azzera e non anticipa niente. AVVIA alle 12:07, ultimo ciclo alle 10:16 ⇒ primo ciclo utile
      alle **16:16:26Z**, cioè **quattro ore dopo l'avvio**, con il capitale fermo nel frattempo.
    - **Il trigger a capitale fermo non può sostituirlo.** Scatta correttamente ($646,26 ≥ $50) ma il
      passo 1 di `miniCiclo` legge `data/realloc-ultimo-piano.json`, che **solo un ciclo completo
      scrive** (`agent41-realloc-scheduler.js:296`). Quel codice è nato alle 11:01 di oggi; l'ultimo
      ciclo completo è delle 10:16. Quindi il file non è mai esistito e il mini-ciclo esce con
      «nessun piano salvato finora» — registrato alle 12:09, 12:19, 12:31, 12:43.
    - **Si autorisolve** al primo ciclo completo e non si ripresenterà su questa macchina. Ma si
      ripresenta **identico** su un deploy pulito, dopo una cancellazione di `data/`, o ogni volta che
      il trigger venga usato per la prima volta. Il costo è una finestra fino a **6 ore** di capitale
      fermo dopo un AVVIA.
    - **Correzione non fatta e da decidere** (nessuna scritta: il turno era di sola diagnosi, poi di
      sola esecuzione). Le due candidate ovvie: far sì che `impostaBot({enabled:true})` azzeri
      `lastRunAt` — così AVVIA *è* l'innesco; oppure far scrivere l'ultimo piano anche al ciclo in
      anteprima a bot fermo, che è già ciò che il codice fa (`calcolaPiano` lo scrive sempre) e che
      quindi coprirebbe il caso da solo alla prima esecuzione post-11:01.

20. **L'hook di piazzamento blocca anche il ciclo di agent41 lanciato a mano — ed è corretto, ma va
    saputo prima.** `.claude/hooks/blocca-piazzamento.js:71` blocca
    `(node|nodemon|npx|bash|sh|./)\s*\S*agent41-realloc-scheduler`. Quindi **una sessione Claude Code
    non può forzare un ciclo**, nemmeno con l'autorizzazione esplicita dell'utente in chat: l'hook non
    legge la chat. L'8 agosto 2026 è successo davvero, con l'operatore che aveva autorizzato in anticipo.
    **Non si aggira** (lo dice l'hook stesso). Il comando lo esegue l'operatore in un terminale, o con
    il prefisso `!` nel prompt:
    ```bash
    cd /root/rewards-bot && PID=$(pm2 pid agent41-realloc-scheduler) && \
    while IFS= read -r -d '' kv; do k=${kv%%=*}; \
      case "$k" in NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|PM2_JSON_PROCESSING|PM2_USAGE|NODE_APP_INSTANCE) continue;; esac; \
      case "$k" in [A-Z]*) export "$kv";; esac; \
    done < /proc/$PID/environ && node agents/agent41-realloc-scheduler.js --once
    ```
    La ricostruzione dell'ambiente **non è opzionale**: agent41 non ha il caricatore di `.env` (§5
    punto 3), e senza quel passo il ciclo parte senza `MANUAL_ORDER_PLACEMENT`, `MAKER_FUNDER_ADDRESS`,
    `KEY_CUSTODY_MASTER` e `DATABASE_URL`.
    **Va lanciato subito dopo uno scatto del trigger**, non a caso: il mini-ciclo del demone gira nello
    stesso capitale e il lucchetto `inCorso` è in-process, quindi non protegge da un secondo processo.
    Dopo uno scatto ci sono **10 minuti** di cooldown, che bastano con margine (il ciclo costa ~52 s di
    piano più il piazzamento). Gli scatti si leggono con
    `grep -a '"tipo":"mini-ciclo"' data/realloc-scheduler.jsonl | tail -1`.

21. **Il trigger a $50 non ha MAI funzionato — corretto in `main`, ASPETTA IL RIAVVIO DI agent41.**
    Dal momento in cui è nato, il mini-ciclo andava in `TypeError` a **ogni** scatto (ogni ~10 min per
    il cooldown): `Cannot read properties of null (reading 'inBand')`, `plan-to-orders.js:151`. Causa:
    la guardia con la truthiness di `find` descritta in §4, e la riga in testa al piano dell'8 agosto —
    «Will Matt Klein be the Democratic nominee for MN-02?» — che ha **`tick: null`**. Falliva **chiuso**
    (eccezione ⇒ nessun ordine, capitale fermo), quindi non ha mai messo a rischio capitale: ha solo
    reso la funzione inutile al 100%.

    Due correzioni, entrambe necessarie e nessuna delle due sufficiente da sola:
    - la **guardia** (`findIndex`), che trasforma l'esplosione in uno scarto dichiarato;
    - lo **scavalcamento della riga rotta** in `scegliMercato`, senza il quale il mini-ciclo si sarebbe
      limitato a rispondere «nessuna azione» per sempre, perché sceglie **un** mercato e non prova il
      successivo.

    Provato in isolamento su dati finti (`lib/maker/gamba-nulla-non-esplode.test.js`, 25/25) e in sola
    computazione sul **piano vero** salvato su disco: zero eccezioni sulle 6 righe, Matt Klein scartato
    con `gamba-impossibile`, le altre 5 costruiscono due gambe ciascuna.

    **Il comando (agent41 non ha il caricatore di `.env` — vedi punto 3):**
    ```bash
    cd /root/rewards-bot && PID=$(pm2 pid agent41-realloc-scheduler) && \
    while IFS= read -r -d '' kv; do k=${kv%%=*}; \
      case "$k" in NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|PM2_JSON_PROCESSING|PM2_USAGE|NODE_APP_INSTANCE) continue;; esac; \
      case "$k" in [A-Z]*) export "$kv";; esac; \
    done < /proc/$PID/environ && \
    pm2 restart agents/ecosystem.config.js --only agent41-realloc-scheduler --update-env && pm2 save
    ```
    **Dopo il riavvio il trigger piazza davvero.** Simulato col saldo vero ($646,26) e con la mappa
    degli ordini a riposo VUOTA (ipotesi peggiore — interrogare il venue non era ammesso): il primo
    scatto utile allocherebbe **$120 sul mercato del morbillo** (`0xd15f77a921`), non i $28,15 liberati
    dalla gamba scaduta. Nella corsa vera `notionalePerMercato` sottrae gli ordini vivi, quindi la cifra
    sarà minore — ma **l'ordine di grandezza da aspettarsi è ~$100, non ~$30**.

22. **Tre cose che il fix ha scoperto e NON ha risolto.** Nessuna è stata toccata: sono decisioni sul
    capitale, e questa sessione era un fix su una guardia.
    - **La rampa non conta niente.** `registraMercatoAperto` (`lib/maker/bot-enabled.js:130`) è
      esportata e **non è chiamata da nessuna riga del repo** (verificato con grep su `lib/`, `agents/`,
      `app/`). `mercatiDallAvvio` resta `[]` per sempre, quindi `rampa()` risponde sempre «0/5, ne
      restano 5» e il tetto delle prime 24h **non si chiude mai** — nemmeno dopo il reset delle 13:02
      che ha abilitato 3 mercati. Il tetto `MAX_POSIZIONI = 10` regge ancora, la rampa no.
    - **Il mini-ciclo non guarda la rampa affatto.** `miniCiclo` non chiama `applicaPolitiche`: conosce
      il tetto di concentrazione, non il tetto dei mercati nuovi. Un mercato del piano con zero ordini
      a riposo ha `spazio = tetto` intero, quindi il trigger può **aprirne uno nuovo** — che è
      esattamente ciò che la rampa esisterebbe per limitare.
    - **La premessa del saldo non regge alla misura.** L'header di `trigger-capitale-fermo.js` dice che
      un BUY a riposo immobilizza il collaterale, quindi «il saldo pUSD libero **è** il capitale non
      allocato». Misurato: alle 12:28 il saldo era `646,262868`; dopo aver piazzato ~$236 di gambe alle
      13:02, alle 13:49 era **ancora `646,262868`** (lettura fresca, `etaMs: 0`, `affidabile: true`).
      O il collaterale non viene immobilizzato come si crede, o la lettura non misura quel pool. Finché
      non si sa, il trigger sovrastima il capitale libero.

23. **IL TETTO DI ORIZZONTE È GIUSTO E NON BASTA: col board di oggi l'universo eleggibile è ZERO.**
    Il tetto a 1,5 g è in `main` e funziona (§4). Ma misurato sul board vero l'8 agosto 2026:
    **115 mercati, e il più corto scade fra 2,41 giorni.** Nessuno entra nella finestra `[0,25 · 1,5]`
    — e non entrerebbe con nessun valore fra 1 e 2. Simulazione del pianificatore vero sull'universo
    vero: `evaluated 114 · chosen 0`, 114 candidati scartati per scadenza.

    **Quindi il vincolo che morde non è il tetto: è cosa `agent24-liquidity-rewards` mette nel board.**
    I 21 wallet entrano su mercati con mediana 5,3 ore — meteo giornaliero, crypto a 5 minuti, sport —
    e nel nostro board non ce n'è **nemmeno uno**. Un esempio dal monitor: «Will the highest temperature
    in Singapore be 32°C on August 8?», 24,1 h alla scadenza, montepremi $51/g, banda 4,5¢: è nel
    programma premi, paga, e noi non lo vediamo. **Questo è il lavoro vero, e non è stato fatto**:
    va capito se agent24 filtra quei mercati o se la sua query a Gamma non li chiede proprio.

    **Conseguenza operativa da sapere PRIMA che accada, perché tocca capitale.** Con il piano a zero
    righe la guardia «universo vuoto» **non scatta** — `universe.evaluated` si conta sui candidati
    valutati, cioè PRIMA del filtro orizzonte, quindi il ciclo legge un piano *magro*, non *cieco*.
    Da lì:
    - il **trigger di valore** non scatta (fresco $0/g contro produzione > $0): nessun reset, gli
      ordini vivi restano dove sono. È il caso normale.
    - il **trigger di validità** invece scatta quando un mercato in gestione si risolve — e allora il
      reset gira con `rows: []`: **cancella tutto e non piazza niente**. Matt Little scade fra ~2,4
      giorni, quindi è previsto che succeda entro quella finestra.

    **Non ho messo una guardia contro questo, ed è una scelta.** L'alternativa sarebbe fermare il
    reset per tenere in piedi ordini su mercati che la politica appena decisa dichiara sbagliati:
    peggio. Uscire è la direzione giusta, riduce esposizione, e il capitale torna liquido in attesa
    che il board abbia mercati veri. Ma va saputo prima, non scoperto dopo.

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

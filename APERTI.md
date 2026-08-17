# Cosa resta aperto — 17 agosto 2026, sera tardi

Scritto perché una sessione nuova possa riprendere **senza rileggere tutto**. In ordine di quanto costa
se non si ripara. Lo stato del sistema al momento della chiusura è in fondo.

---

## IL QUADRO — dove siamo

| | |
|---|---|
| **flotta pm2** | **11 processi ONLINE**, utente `bot`, `cwd` `/home/bot/bot` · `pm2 save` fatto |
| **cinture** | **4/4 inserite** su agent40 e agent41, lette da `/proc/<pid>/environ` — e da oggi **mordono tutte e quattro** |
| **passi del giro completo** | **18 su 18** |
| **regole che scattano** | **20 statiche + 15 dinamiche su 91**, col cablaggio di produzione |
| **determinismo** | **10 corse su 10**, firma `3589516fd10666bf` — e **identico su due snapshot diversi di `data/`** |
| **suite** | 209 test · 195 verdi · **10 rossi NOTI** + 1 timeout + 1 che non parte |
| **bot** | **FERMO**, perno vuoto, allowlist vuota, selezione spenta, **zero ordini a libro** |

---

## 1 · 🚚 LA MIGRAZIONE — chiusa, e cosa ha lasciato

**Il repo è `/home/bot/bot`, utente `bot`.** `/root` non è leggibile (`sudo` chiede la password), quindi
`/root/bot` e `/root/prediction-market` **non sono stati né letti né cancellati**: se ci sono, nessuno li
ha toccati.

**Dodici percorsi assoluti** erano diventati puntatori a niente (`57de3e8`, `abed26d`) e **nove file di
servizio in `/tmp`** non erano più scrivibili (`8636282`). La forma del guasto è sempre la stessa e per
questo nessuno se n'era accorto: *ogni lettore ha già un ramo per «non l'ho letto», e quel ramo si prende
la scena.*

| dove | come falliva |
|---|---|
| `ecosystem.config.js` — 11 `cwd` + 11 `HOME` | pm2 non trovava gli agent |
| `rewards-normalize` **+ `agent24.OUTPUT_FILE`** (gemello scrittore) | `readJson` → `null` ⇒ board **vuoto**, non illeggibile |
| `agent34` watchlist/mid-history/tape · `agent45` log guardiano | zero sottoscrizioni, «il guardiano non ha detto niente» |
| `route.ts` allocate · `rewards-selfcheck` | figlio morto ⇒ «output not JSON»; 3 asserzioni saltate |
| **`banco-ciclo-completo.VIVO`** | **il cancello si APRIVA**: `diff` esce 2, il `catch` legge stdout vuoto = zero differenze |
| **i 9 file di `/tmp`** | di `root`, sticky bit ⇒ né riscrivibili né cancellabili: gli scrittori in EACCES e **i lettori sulla copia vecchia, che non invecchia più** |

**La policy dei permessi era la parte peggiore**: l'hook `PreToolUse` puntava a `/root/rewards-bot/…` e
**non girava più**; le 7 regole `Edit(//root/rewards-bot/…)` non corrispondevano a niente, cioè `.env`,
`ecosystem.config.js` e i sei flag di stato erano modificabili **senza `ask`**; `~/.claude/settings.json`
aveva perso la copia. Rimessi: hook su `$CLAUDE_PROJECT_DIR`, **164 `ask`** in entrambe le copie.

**Due difese nuove nate da qui:**
- `lib/percorsi-runtime.js` — directory di servizio **per utente** (`/tmp/rewards-bot-<utente>`, 0700),
  una definizione al posto di ~40 letterali in 23 file. Il guasto non è riparato: è **inesprimibile**.
- `lib/safety/percorsi-critici.js` — controllo all'avvio nei **nove agent** che scrivono. Su percorso
  inutilizzabile: stderr + `exit 1`. ⚠ Un file **assente** non è mai un errore (è il primo avvio); non si
  controlla il **contenuto** (la freschezza ha già i suoi presidi). Test **15/0**, che costruisce ogni
  guasto vero e poi **lo rimette a posto** — un controllo sempre rosso non distingue niente.

---

## 2 · 🔒 LE QUATTRO CINTURE — e adesso mordono tutte

Regola per intero in **CLAUDE.md §4.14**. Erano cinque e ne mordeva **una**.

| cintura | dove morde | gate | valore vivo |
|---|---|---|---|
| `MAKER_MODE` | `evaluatePlacementGate`, via `buildPlacementAdapter` | `maker-mode` | `off` ⇒ **inserita** |
| `MAKER_ADAPTER_DRYRUN` | idem | `dry-run` | `true` ⇒ **inserita** |
| `MANUAL_ORDER_PLACEMENT` | l'ultimo `if` prima della POST | — (`dry-run-validated`) | `dry-run` su agent40 ⇒ **inserita** |
| freno di agent41 | `giro()` + `controlloCapitaleFermo` | — (non si invia) | **assente ⇒ inserita**, fail-closed |

**`MAKER_PLACEMENT` è stata TOLTA** (decisione dell'operatore): non era pericolosa, era **finta**. Il
ripiego sull'ambiente in `adapter.js` non aveva chiamanti, perché l'unico costruttore passa sempre
`placement` esplicito. ⚠ **Toglierla stringe**: senza ripiego, un chiamante che non passa `placement`
ottiene `dry-run`.

**La prova**: `node scripts/ricerca/prova-cinture.js` — **10 verdi, 0 rossi**. Ognuna inserita **da sola**
con le altre tre aperte ⇒ zero ordini al venue, col gate atteso; più il **CONTROLLO** (quattro aperte ⇒
l'ordine parte), senza il quale quattro rifiuti non proverebbero niente.

⚠ **La prima corsa le dava tutte e tre rosse per colpa del BANCO**, non della produzione: il suo adapter
simulato cablava modo/`dryRun`/`placement` ignorando gli `opts` — **più permissivo del venue proprio
sulle cinture**, cioè non le avrebbe mai potute smascherare. Corretto: il seam è solo la rete.

---

## 3 · 🧪 IL BANCO — 18/18, deterministico, e indipendente da `data/`

```bash
cd /home/bot/bot-banco && node scripts/ricerca/banco-scenari.js
cd /home/bot/bot-banco && node scripts/ricerca/prova-determinismo-banco.js
```

Il worktree è **`/home/bot/bot-banco`**, allo stesso commit, `data/` copiato, `node_modules` collegato.
Il banco **chiede a `git worktree list`** dove sia il repo vivo invece di cablarlo, e un'uscita di `diff`
diversa da 1 è un **errore**, non uno zero.

**Il passo 13 prendeva `candidati13[0]`** — il primo mercato coperto sui due lati trovato iterando gli
ordini vivi, cioè un ordine che dipende da `data/`. Ora **si costruisce il proprio mercato** e lo apre dal
percorso di produzione. ⚠ **Filtrare i candidati non bastava**: restava comunque solo il mercato del passo
12. ⚠ **E servono `giro()` + `controlloCapitaleFermo()` in quest'ordine**: `ripristinaGamba` pretende una
riga nel piano **salvato**, e quel file lo scrive solo il ciclo pesante.

**Su due snapshot diversi di `data/`**: 18/18 entrambi, **20+15 identiche**. ⚠ Alla prima misura erano 16
contro 15, e la causa era `maker-allocated-capital.json` — l'unica memoria di un piano precedente a
sopravvivere all'«accensione da zero». Aggiunta ai file azzerati: **22+17 → 20+15**, e ora è una misura.

---

## 4 · 📉 I CINQUE MERCATI CORTI (24-72 h) — sola misura

`node scripts/ricerca/mercati-corti-24-72h.js` · board 141 righe · capitale $147 · tetto $61,25.
**Imbuto**: 141 → −49 pavimento oltre il tetto → −61 selezione → −5 fuori finestra → −4 netto non
calcolabile ⇒ **22 candidabili**.

| # | mercato | netto/g | lordo/g | quota | concorrenza | prof. altrui | minSize | pavimento |
|---|---|---|---|---|---|---|---|---|
| 1 | Eric Yonce FL-06 D | **$5,14** | $10,07 | 9,24% | 601 share | $951 | 50 | $61,25 |
| 2 | Fishback 10–15% | $3,66 | $6,82 | 9,09% | 613 | $1.246 | 50 | $61,25 |
| 3 | Keith Gross FL-02 R | $2,12 | $3,88 | 4,04% | 1.454 | $1.546 | 50 | $61,25 |
| 4 | Cory Mills FL-07 R | $1,18 | $2,68 | 2,68% | 2.221 | $1.053 | 50 | $61,25 |
| 5 | Joe Strada FL-11 R | $1,07 | $1,75 | 1,70% | 3.532 | $5.969 | 50 | $61,25 |

Tutti `minSize 50` ⇒ pavimento **$61,25 = esattamente il tetto**; al tetto **62,5 share/lato**, minimo
superato con 12,5 di margine.
⚠ **Scadono tutti e cinque nello stesso istante** (2026-08-18T23:59Z, primarie della Florida). Su un
mercato corto conta il **totale prima della scadenza**: **$6,01 · $4,29 · $2,48 · $1,38 · $1,25**.

**Cosa succede alla scadenza con una coppia aperta** — letto dai moduli, non scritto a mano:

| quando | cosa | con una coppia aperta |
|---|---|---|
| **−24 h** | la **selezione rilascia lo slot** | spegne **l'ingresso, non l'uscita**: la posizione resta gestita da §4.8 |
| −12 h | esce dall'universo del **piano** | niente righe nuove; ciò che è a libro non viene toccato |
| −3 h | **chiusura forzata** | una coppia **completa non si forza** ($1 comunque); una gamba **nuda** viene spinta all'uscita |
| −3 min | `market-too-close-to-close` | nessun ordine nuovo, **nemmeno un rinnovo** |
| 0 | chiusura | gli ordini non rinnovati muoiono per **GTD entro 23 min** |
| ore dopo | **risoluzione** (≠ chiusura) | riscatto su `payoutDenominator > 0` **on-chain**, mai su `closed` |

⚠ Su questi cinque **la prima tappa è fra ~4 ore**, non fra 16: è la selezione a 24 h.

---

## 5 · 💰 IL CAPITALE FERMO — le tre vie, coi numeri. **Nessuna applicata.**

`node scripts/ricerca/tre-vie-capitale-fermo.js` · capitale $147 · tetto oggi **$61,25** (scaglione
finanziabile 50) · tetto per ordine $65,63.

> **⚠ LA PREMESSA DELLA DOMANDA È VERA SOLO SE SI FORZA UN MERCATO SOLO.** Lasciato libero al tetto di
> oggi, **il pianificatore impiega tutti i $147 su TRE mercati, con 0% fermo**. Gli $85,75 fermi sono la
> conseguenza del vincolo «un mercato», non del tetto.

**(a) UN mercato** — impiegato **$61,25**, fermo **$85,75 = 58,3%**. Residuo irraggiungibile peggiore
**$45,24** (minSize 50, lato caro). ⚠ Non è una configurazione che il bot produca da solo: la selezione
apre tre slot.

**(b) ALZARE IL TETTO — la scala è DISCRETA.** Il tetto è `pavimentoPremiante(minSize)` dello scaglione
finanziabile, e i `minSize` del venue sono 20 · 50 · 100 · 200 · 1000. Quindi vale **$24,50 · $61,25 ·
$122,50 · $245 · $1.225 e nient'altro**: «alzarlo a $147» **non è esprimibile** (servirebbe un `minSize`
120, che non esiste).

| scaglione | tetto | Δ vs oggi | mercati | impiegato | fermo | candidabili | residuo peggiore |
|---|---|---|---|---|---|---|---|
| 20 | $24,50 | −$36,75 | 6 | $144,00 | $3,00 | 37 | $19,07 |
| **50 (oggi)** | **$61,25** | — | 3 | $147,00 | $0,00 | 93 | $45,24 |
| 100 | $122,50 | +$61,25 | 3 | $147,00 | $0,00 | 131 | $45,24 |
| 200 | $245,00 | +$183,75 | 3 | $147,00 | $0,00 | 142 | $45,24 |
| 1000 | $1.225 | +$1.163,75 | 3 | $147,00 | $0,00 | 142 | $45,24 |

⚠ **Il capitale impiegato NON è la leva**: da $61,25 in su è già tutto, e restano tre mercati. Quello che
cambia davvero è **quanti mercati diventano candidabili** (37 → 93 → 131 → 142) e il **residuo peggiore**,
che salta da **$19,07 a $45,24** fra lo scaglione 20 e il 50 e poi non cresce più (lo limitano i due tetti).
⚠ **Alzare il tetto per mercato alza anche il tetto per ordine** (`liveMinOrderCapUsd`), e con esso
l'esposizione di un singolo invio.

> **⚠ LA COLONNA «realistico $/g» NON È CONFRONTABILE FRA LE RIGHE, E LA MISURA LO DICHIARA DA SOLA.**
> Le cinque righe sono cinque corse del pianificatore, ~2 minuti ciascuna. Il tetto di oggi girato
> **prima** della scala dà **$57,17/g**, girato **dopo** **$102,84/g**: **fattore 1,8× in dieci minuti**.
> **Non è rumore fra corse** — tre corse consecutive stanno entro l'**1%** ($57,63 · $57,17 · $57,63) — è
> **DERIVA**: il board si riscrive ogni 15 minuti e lo storico di agent34 si sta ancora riempiendo dopo il
> riavvio della flotta. Le colonne **strutturali** (mercati, impiegato, fermo, candidabili, residuo) sono
> solide; il $/giorno si legge come ordine di grandezza, e **solo confrontando corse ravvicinate**.

**(c) DUE mercati** — impiegato **$122,50**, fermo **$24,50 = 16,7%**. Residuo irraggiungibile peggiore
**TOTALE $90,48**: è per-mercato per costruzione, quindi due mercati aperti sono **due** residui
possibili. Il tetto sull'esposizione aperta resta **$150** (conta i fill riconciliati, non gli ordini a
riposo) — cioè con due mercati pieni il margine sul cap è $27,50.

---

## 6 · LA SEQUENZA DI ARMAMENTO — scritta, **NON eseguita**

### Le precondizioni — nessuna è una cintura, e tutte vanno vere PRIMA

| # | cosa | come si verifica |
|---|---|---|
| P1 | il mercato del giro è scelto e la sua riga di piano esiste | `node scripts/cli/mercati.js` · `data/realloc-ultimo-piano.json` |
| P2 | **il perno** `MAKER_LIVE_MIN_MARKET=<conditionId>` in `agents/ecosystem.config.js` | riavvio **dal file e insieme**, poi `mercati.js` deve dire **1 mercato ed è quello** su ENTRAMBI |
| P3 | KILL spento · **AVVIA** (oggi è FERMA) · interruttore riprezzo acceso | `node scripts/cli/stato.js` |
| P4 | i limiti sono quelli decisi | per ordine $80 · esposizione $150 · perdita giornaliera $100 · 40 invii/60 s |
| P5 | il saldo copre il piano | il tetto si clampa al capitale: sotto $61,25 il piano si stringe da sé |

⚠ **P2 è la più importante**: senza perno il perimetro è *una conseguenza* dell'unione di §4.8 e **cambia
da sé** quando la posizione si chiude. E il perno **restringe**: un mercato con posizione non riceve più
il BUY di completamento coppia — chi lo vuole toglie il perno, non c'è una terza via.

### I passi che armano, in questo ordine

| ordine | cintura | dove | perché qui | cosa si verifica DOPO |
|---|---|---|---|---|
| **1°** | freno di agent41 · `REALLOC_SCHEDULER_DRY_RUN: '0'` | ecosystem, blocco agent41 | agent41 **tenta** e attraversa tutti i gate; con le altre tre inserite **nessun ordine raggiunge il venue**. Si osserva la pipeline a costo zero, ed è il passo che si disfa senza conseguenze | `stato.js` → 3/4 inserite, `puoPiazzare=false`; nel giornale `manual-place` con `dry-run-validated`, **zero** `sent`. Se compaiono `reject-*`, si legge il gate e **ci si ferma**: quello è il difetto da capire, non da aggirare |
| **2°** | `MAKER_MODE: 'live-min'` | ecosystem, **agent40 E agent41** | da oggi **gate anche la corsia manuale** (§4.14): finché è `off` nessun ordine passa, qualunque cosa dicano le altre | `stato.js` → 2/4; il gate `maker-mode` sparisce dai rifiuti |
| **3°** | `MAKER_ADAPTER_DRYRUN: 'false'` | ecosystem, **entrambi** | l'ombra forzata, che ora arriva davvero all'adapter | `stato.js` → 1/4; il gate `dry-run` sparisce dai rifiuti |
| **4°** | `MANUAL_ORDER_PLACEMENT: 'send'` | ecosystem, **entrambi** | **è l'ultima cosa fra il piano e il libro.** Va per ultima, da sola, con un solo mercato nel perimetro | entro **due minuti**: `stato.js` → `ordini a riposo` **2** e non più; `mercati.js` → perimetro ancora **1**; nel giornale `sent` **esattamente due volte**. **Se compare un terzo ordine, o su un mercato diverso, si preme FERMA** |

⚠ **I processi che decidono un prezzo si riavviano INSIEME e DAL FILE** (`--update-env` non rilegge
l'ecosystem): armarne uno solo produce un bot che apre e non rinnova.
⚠ **E dopo ogni cambio va rifatto `pm2 save`**, o il `@reboot` riporterebbe su la flotta di prima.

### Cosa guardare nella prima ora

| quando | cosa | rosso se |
|---|---|---|
| +2 min | `stato.js` · ordini a riposo | ≠ 2, o su un mercato che non è il perno |
| +5 min | giornale `ripristino-gamba` | `esito: rifiutata` con un gate che non sia una regola di rischio |
| +20 min | i due ordini sono ancora vivi (GTD 23 min ⇒ rinnovo) | zero ordini e nessun `manual-replace` |
| +30 min | `agent43-guardian` | un `PRE-ALLARME (1/2)` è normale; due letture consecutive fanno scattare il guardiano ed è **giusto** |
| a ogni fill | `carico-di-ripiego` con la sua `fonte` | `skip-no-entry-price`: il carico non è arrivato, e l'uscita non parte |

### Come si disarma

**Immediato, senza riavvio**: `node scripts/cli/ferma.js`. Il **KILL** cancella tutto ma ⚠ ferma **anche
l'uscita automatica**: è l'emergenza, non l'interruttore operativo. **Definitivo**: rimettere le cinture
nell'ecosystem e riavviare dal file.

---

## 7 · CIÒ CHE RESTA APERTO, col motivo

| # | cosa | perché è ancora aperto |
|---|---|---|
| 1 | **`pm2 startup` non fatto** | richiede root, `sudo` chiede la password. Al suo posto una riga `@reboot … pm2 resurrect` nella crontab di `bot` (cron è `active`). Il comando giusto è in CLAUDE.md §5.1; fatto quello, **la riga di cron va tolta** |
| 2 | **`git push` bloccato — 79 commit locali** | remote HTTPS, nessuna credenziale: `could not read Username`. Serve una chiave SSH o un PAT, e non può farlo un agente |
| 3 | **`npm run build` fallisce** | manca `lucide-react`, causa preesistente. Il JS compila (`✓ Compiled successfully`), muore nel type-check. Il `dashboard` non è nella flotta ⇒ non serve a nessun processo vivo |
| 4 | **10 rossi noti su 209 test** | ruotano nei NOMI, non nel conteggio. Elenco in CLAUDE.md §5.2 p.11. Fra questi i **tre di §5.2 p.37**, rossi **apposta** perché $150 sta sotto `3 × $61,25` |
| 5 | **`tre-fix-sicurezza` scade nella suite** | 48-50 s contro il limite di 60 s. Da solo fa **42/0**. O si accorcia o si alza il limite: è una decisione |
| 6 | **la sentinella vede il vuoto, non il collasso** | il ramo ③ azzera l'orologio se `ordiniARiposo > 0`: un calo da 23 a 2 è invisibile. La cura è un secondo criterio, e va tarato su una misura che oggi non esiste |
| 7 | **che il residuo NASCA** | la via d'uscita esiste (riscatto on-chain, nessun minimo). Resta a monte: le leve sono size e profondità, non un meccanismo nuovo |
| 8 | **il perimetro è una conseguenza, non una dichiarazione** | selezione spenta + allowlist vuota + perno vuoto ⇒ il perimetro è dedotto dall'unione di §4.8 e **cambia con le posizioni**. Il perno lo rende stabile, ed è un atto di armamento |
| 9 | **la rotazione toglie il tetto sul numero di mercati esposti** | tre quotano, N completano. Non è misurato quanti possano stare in gestione insieme su book veri |
| 10 | **la cadenza adattativa è sotto-risolta** | agent40 classifica il 99,6% «lenta» mentre `leggiFinestraTutti` vede `rangeMid = 0` sul 48,8%: il conto non torna. Non è la leva |

---

## Stato del sistema — 17 agosto 2026, sera tardi

**Bot FERMO e disarmato**, letto da `/proc/<pid>/environ` degli 11 processi vivi:

| | agent40 | agent41 |
|---|---|---|
| `MAKER_MODE` | `off` ⇒ inserita | `off` ⇒ inserita |
| `MAKER_ADAPTER_DRYRUN` | `true` ⇒ inserita | `true` ⇒ inserita |
| `MANUAL_ORDER_PLACEMENT` | `dry-run` ⇒ inserita | assente ⇒ inserita |
| `REALLOC_SCHEDULER_DRY_RUN` | — | assente ⇒ **inserita** (fail-closed) |
| `MAKER_LIVE_MIN_MARKET` | **vuota** | **vuota** |

⇒ **4/4 inserite su entrambi**, coerenti col `.env`. `MAKER_FUNDING_APPROVED=true` su entrambi: non è una
delle quattro, è un'**attestazione**, cioè una cintura nella posizione aperta.

AVVIA **FERMA** (16/08 18:47:16Z, `by: cli/ferma`) · KILL spento · allowlist **vuota** · selezione
**spenta** · `guardian-state.json` assente · **zero ordini a libro** · **perimetro live-min = 1**
(`0xe9b3e28d`, Hong Kong, 6 share sotto il minimo del venue ⇒ quotabile **zero**) · snapshot posizioni
**fresco** (< 180 s) ⇒ `venue-positions-unreadable` non rifiuta più.

**Il feed è vivo**: agent34 su 91 mercati / 182 asset, board di ~141 righe, agent38 dice `ok`.
I file di servizio stanno in **`/tmp/rewards-bot-bot/`** (0700), non più in `/tmp` nudo.

---

## Come ripartire

```bash
cd /home/bot/bot && claude --permission-mode auto
```

```bash
# 1 · LO STATO VERO, dai processi vivi
node scripts/cli/stato.js              # le quattro cinture da /proc/<pid>/environ
node scripts/cli/mercati.js            # perimetro live-min, stessa fonte

# 2 · LE PROVE, in ordine di quanto provano
cd /home/bot/bot-banco && node scripts/ricerca/banco-scenari.js            # 18/18
cd /home/bot/bot-banco && node scripts/ricerca/prova-cinture.js            # 10/0, col controllo
cd /home/bot/bot-banco && node scripts/ricerca/prova-determinismo-banco.js # 10 corse, una firma
node scripts/ricerca/suite-rossi.js <nome-sessione>                        # si confrontano i NOMI
node lib/safety/percorsi-critici.test.js                                   # 15/0

# 3 · LE MISURE SUL CAPITALE
node scripts/ricerca/mercati-corti-24-72h.js       # i candidabili fra 24 e 72 h
node scripts/ricerca/tre-vie-capitale-fermo.js     # le tre vie (lento: 7 corse del pianificatore)
node scripts/ricerca/residui-sotto-il-minimo.js    # il residuo peggiore, e perché l'uscita è il riscatto
```

⚠ **Riavviare i due processi che decidono un prezzo si fa DAL FILE e INSIEME**, e si chiede in chat ogni
volta (§2 regola 2):

```bash
pm2 restart agents/ecosystem.config.js --only agent40-manual-reprice,agent41-realloc-scheduler
pm2 save     # o il @reboot riporterebbe su la flotta di prima
```

**Le due regole che valgono più di tutte, imparate oggi:**
1. *Un test che inietta una fixture deve COPIARE la forma vera, non inventarla.* Tre difese scritte ieri
   erano inerti e i loro test erano verdi.
2. *Un presidio simulato più permissivo dell'originale non è un presidio.* Il banco cablava le cinture e
   quindi non avrebbe mai potuto smascherarle — lo stesso difetto, un piano più su.

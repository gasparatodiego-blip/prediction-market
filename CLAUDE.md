# CLAUDE.md — contesto permanente del progetto

Questo file viene letto automaticamente all'avvio di ogni sessione Claude Code aperta da
`/root/rewards-bot`. **Il contesto vive qui, non nel prompt.**

Ultima verifica contro codice/stato reali: **14 agosto 2026**, ~01:20 UTC.

> ⚠️ **QUESTO FILE È STATO COMPATTATO IL 13 AGOSTO 2026** (494k → ~110k) su istruzione dell'operatore.
> Non è stata tolta nessuna regola, nessuna costante, nessuna trappola operativa e nessuna questione
> aperta: è stata tolta la **cronologia**, cioè il racconto di come si è arrivati a decisioni che oggi
> sono semplicemente vere. Ogni voce chiusa sopravvive come **una riga** nel registro di §5-bis, con il
> numero originale, così un riferimento del tipo «§5 punto 72» resta risolvibile. La storia integrale
> resta in `git log` e nei commit citati. **Chi aggiunge una voce nuova scriva già compatto.**

---

## 🔴 STATO OPERATIVO — 13 agosto 2026, 09:35 UTC

| | |
|---|---|
| **KILL** | **spento** (`killed:false` dal 12/08 20:30:22Z) |
| **AVVIA/FERMA** | 🛑 **FERMA** dal 13/08 **09:08:35Z**, `by: agent43-guardian` — **non** dall'operatore |
| **Freno di prova** | **disinserito** (`REALLOC_SCHEDULER_DRY_RUN=0`) — agent41 invia ordini veri |
| **Guardiano perdite** | 🛑 **SCATTATO** alle 09:08:33Z — `data/guardian-state.json` presente, **latch attivo** |
| Capitale | **$624,42** totali contro baseline **$660,56** ⇒ **−$36,15 / −5,47%** |

> ## 🛑 IL GUARDIANO È SCATTATO — 13 agosto 2026, 09:08:33Z, SECONDO SCATTO REALE
> Perdita oltre **entrambe** le soglie nello stesso giro: **−5,47%** contro il limite del 5% e
> **−$36,15** contro il limite di $30. Baseline $660,56 → totale $624,42. Il guardiano ha fatto
> esattamente il suo mestiere: **23 ordini cancellati su 12 mercati** e bot su **FERMA**.
> **⚠ NON C'È RIARMO AUTOMATICO, ED È VOLUTO**: si riparte cancellando `data/guardian-state.json` a
> mano e premendo AVVIA. È una decisione dell'operatore sul capitale, e nessuna sessione la prende.
> **⚠ COSA CONTINUA A GIRARE CON FERMA**: agent40 chiude e riprezza le posizioni aperte (§2 — FERMA
> ferma le APERTURE, non la gestione). Misurato dopo lo scatto: 34 intent di `auto-close-on-fill` in
> 23 minuti. Il capitale scoperto **non** è abbandonato.
> **⚠ E LA SENTINELLA NON PUÒ VEDERLO**: con il bot su FERMA il vuoto è lo stato corretto, quindi la
> sentinella si azzera per costruzione. Vedi la questione aperta in §5.2 punto 9 — il ramo
> `ordiniARiposo > 0` non distingue **2 ordini da 23**, cioè non vede un collasso progressivo.

> ## 🕳️ IL VUOTO DI TRE ORE, E COSA NE RESTA — §5-bis p.120-122
> Il 13 agosto, fra le 02:53 e le 05:56, **zero ordini a riposo per 180 minuti** con KILL spento,
> AVVIA acceso e $609,10 liquidi: non un processo caduto, ma **tre numeri in tre moduli che non si
> parlavano** — righe di piano a $24,00 contro un pavimento di $24,50 ⇒ 114 rifiuti identici. La
> regola che lo impedisce vive in **§4.3** (la griglia limitata anche dal tetto, 8 livelli minimi), la
> diagnosi per intero in §5-bis p.120. **⚠ Era un dente di sega: peggiorava crescendo il capitale.**
> **⚠ E le modifiche a `lib/rewards/allocator.js` entrano in servizio SENZA RIAVVIO** — il piano nasce
> in un processo figlio che rilegge il file da disco a ogni ciclo (§5.3). Vale la pena saperlo prima.
> Dallo stesso episodio: la **sentinella sul vuoto** (§5-bis p.121, 5 min ⇒ ricostruzione immediata) e
> il **recupero della scadenza a tre fonti** (p.122: `recordDaRigaBoard` non mappava `endDate`, e 5
> posizioni su 7 erano senza scadenza, quindi la chiusura forzata a 3 ore non poteva scattare).

> ## 🤖 IL BOT SI SBLOCCA DA SOLO: RIFIUTI RIPETUTI, COERENZA, SCALA, AUTODIAGNOSI — §5 punti 124-127
> **Principio: ogni difesa AGISCE, non segnala soltanto** — qui non c'è nessuno a leggere i log. E la
> metà opposta: **quando l'unica via d'uscita violerebbe una regola di rischio, il bot non agisce e lo
> dichiara.**
> **① RIFIUTI RIPETUTI** (`sblocco-progressivo.js`): **5** rifiuti identici di fila sulla stessa coppia
> (mercato, gate) sono un blocco strutturale — il 13 agosto sono stati **114**. Le 37 famiglie sono in
> tre classi: **`rischio`** (56% dei 43.299 rifiuti) ⇒ **nessuna azione, si cambia mercato e si dichiara
> perché**; **`stato-bot`** ⇒ via alternativa vera; **`transitorio`** ⇒ non è un blocco. **Una famiglia
> sconosciuta è trattata come rischio.**
> **② COERENZA FRA I MODULI** (`coerenza-soglie.js`): prima di proporre righe si verifica che chi le
> riceve le accetti, e il capitale **può solo SCENDERE**. Due divergenze misurate: il deadlock $24,00
> contro $24,50, e **il pianificatore non conosce il tetto per ORDINE** (**243 mercati su 321 lo
> sfonderebbero al tetto pieno**, e il giornale porta 631 `manual-order-cap` in tre giorni).
> **③ SCALA DI SBLOCCO**, un gradino ogni **5 minuti**: `ricostruisci-piano` → `ricarica-configurazione`
> → `riconcilia-esposizione` → `ripara-precondizioni` → `risveglia-feed` → **`fermati-in-sicurezza`**
> (FERMA + allarme grave). Caso peggiore: FERMA in **~30 minuti**. **Nessun gradino tocca una regola di
> rischio**, ed è provato per struttura.
> **④ AUTODIAGNOSI ogni 120 s**: ordini vivi > 0 · capitale al lavoro ≥ **50% per 15 minuti** · un ciclo
> negli ultimi **20 min** · rinnovi dovuti non fermati oltre l'**80%**. Tutto illeggibile ⇒ **non si
> giudica** e la scala non parte.

> ## 💵 IL «CAPITALE AL LAVORO» DICEVA L'INTENZIONE, NON IL FATTO — §5 punto 124
> `impegnatoOra = giro.allocatoUsd`, cioè **il piano del giro**. Misurato il 13 agosto 06:47:52: il giro
> aveva allocato **$284**, ma di 17 gambe ne sono passate **8** — nozionale reale **$127,79**. La riga
> «CAPITALE AL LAVORO» dichiarava **$578,40 = 87%** contro un valore onesto di ~63%, e la misura vera
> del giro dopo diceva **44,3%**. Sbagliava **sempre nella direzione che rassicura**, ed è il numero su
> cui l'autodiagnosi decide se il bot lavora. Adesso si sommano i nozionali delle sole gambe non
> rifiutate né saltate, **passate precedenti comprese**; una riga senza `notionalUsd` vale **zero**.
> ⚠ **Il pannello Polymarket e il bot misurano cose diverse e possono essere entrambi giusti**:
> «disponibile per il trading» **è il cash** e non sottrae i BUY a riposo, quindi gli «impegnati» del
> pannello sono le **sole posizioni**; il bot conta **posizioni + ordini a riposo**.

> ## 🩸 DOVE MUOIONO LE GAMBE: `coppia-non-atomica` È LA PRIMA CAUSA — §5 punti 129-130
> **Conto esatto sulle 24 ore (33 giri): 284 gambe pianificate · 260 inviate · 155 accettate · 105
> rifiutate · 24 saltate ⇒ tasso di accettazione 54,6%.**
> **84 gambe perse per $1.276,13 sono `coppia-non-atomica`** (difetto, corretto) · 20 per cap cumulativo
> · 11 per $268,95 `manual-order-cap` (stessa causa) · 9 per $121,23 `mai-primo-sul-libro` (regola di
> rischio, perdita voluta) · 4 per $129,95 cap di esposizione.
> **65% delle gambe perse sono coppie abbandonate INTERE perché UNA gamba sfondava il tetto per
> ordine** — il precontrollo atomico di §5 p.115 fa il suo mestiere (meglio zero invii che una gamba
> orfana), ma la causa a monte è che **il pianificatore non conosce il tetto per ordine**.
> **⚠ E LA CORREZIONE DI STAMATTINA ERA INERTE**: `adattaRighe` girava sul piano **salvato**, e la
> ricostruzione sovrascriveva `righeCandidate` con righe mai passate di lì. Adesso è una funzione
> (`adattaAlleSoglie`) chiamata da **entrambe** le fonti, e un test lo asserisce per nome.

> ## 💰 IL RISCATTO AUTOMATICO DOPO LA RISOLUZIONE — §5 punto 131
> `redeemPosition` esisteva, era provata on-chain e **non aveva chiamanti**. Adesso
> `lib/maker/riscatto-automatico.js` lo chiama, agganciato alla scansione dei registri di agent40.
> **⚠ IL SEGNALE È `payoutDenominator(conditionId) > 0` LETTO ON-CHAIN, non «il mercato è chiuso»**:
> `closed`/`acceptingOrders` diventano veri **ore prima** che l'oracolo riporti l'esito, e un tentativo
> prima è un revert che costa gas e non dice niente. **Non letto ⇒ non si riscatta.**
> **Idempotente** con registro su disco (`data/riscatti.json`): fra l'invio e la sparizione del token
> passano secondi, e in quella finestra un secondo giro riproverebbe. **3 tentativi**, poi **10 minuti**
> di backoff per mercato. Al più **3 mercati per giro**: è manutenzione, e ogni transazione costa gas al
> relayer di terzi. `negRisk` non booleano ⇒ non si tenta.

> ## 🔭 IL BOT VEDE 111 MERCATI SU 1.276 PREMIATI — E NON È LUI IL COLLO — §5 punto 132
> **La catena**: la scoperta trova **1.276 mercati premiati** → `REWARD_MAX_CLOB_MARKETS = 150` ne
> processa 150 → il board finale ha **111 righe**. **1.126 (88%) non vengono mai guardati.**
> **⚠ Il tetto NON si può alzare**: 2,81-3,41 s/mercato misurati; vedere i 1.276 costerebbe **~60 minuti**
> contro un limite di freschezza di 25.
> **Il collo vero è l'ORDINAMENTO**: i 150 si scelgono per **montepremi**, e il montepremi alto vive sui
> `minSize` grandi — 1.000 share chiedono **$1.225 per mercato**. I meteo giornalieri, `minSize 20`, sono
> gli unici alla portata e venivano **seppelliti**. **Correzione: metà dei 150 posti è riservata ai
> mercati con `minSize ≤ 100`**, ordinati fra loro per montepremi.
> **⚠⚠ MA VEDERNE DI PIÙ NON ALZA I MERCATI QUOTATI, OGGI**: il vincolo che morde non è la scoperta, è il
> **tasso di accettazione del 54,6%** (§5 p.129) e il tetto di 12 mercati per giro. La quota di scansione
> è **assicurazione** per quando il board si assottiglia, non la cura di adesso.

> ## 🩹 LE DIFESE DI STAMATTINA AVEVANO DUE DIFETTI, ED ERANO MIEI — §5 punti 135-136
> **① `ultimoCicloOk` non veniva mai aggiornato.** Inizializzato al riavvio e mai timbrato: l'autodiagnosi
> dichiarava «nessun ciclo da N minuti» **mentre il bot piazzava 12 gambe su 14**, salendo la scala fino al
> **gradino 5 ogni mezz'ora**. Adesso si timbra in **tre** punti — quando il giro arriva in fondo con delle
> scelte, e nei due rami che escono con «nessuna azione», perché **anche un giro che non trova niente HA
> girato**. Non si timbra all'inizio, o si timbrerebbe un giro che poi esplode.
> **② `coppia-non-atomica` non era nella mappa delle famiglie.** È **la prima causa di perdita di gambe** e
> finiva in «sconosciuta ⇒ rischio ⇒ non si aggira». Censimento dei tre giorni: **30 gate osservati, 10
> mancavano**. Aggiunte tutte (37 famiglie).

> ## 🧹 IL CICLO PESANTE SI FERMAVA PERCHÉ LA FONTE È SPORCA, NON PERCHÉ IL CONTROLLO È STRETTO — §5 p.137
> «Dopo 3 ricalcoli il piano contiene ancora mercati che il venue rifiuta»: il ciclo da 6 ore non girava
> da 03:42. L'esclusione **veniva passata**, ma il ricalcolo ripesca dallo **stesso board**, e il board è
> sporco per una **CLASSE** di mercati — il motivo misurato è `premio-crollato` («da $100/g a $5/g»).
> **Tre passate contro N mercati sporchi non convergono, e N > 3.**
> **Si pulisce la fonte, non si allenta il controllo**: la verifica al venue è intatta, ma il suo esito ora
> **sopravvive al ciclo** (`lib/maker/quarantena-venue.js`). Un mercato bocciato resta fuori dal piano per
> **20 minuti** — poco più del periodo con cui agent24 riscrive il board. **Non è un cancello**: se un
> mercato in quarantena arrivasse al piazzamento, tutti i gate lo giudicherebbero come prima.

> ## 🛡 IL GUARDIANO NON SCATTA PIÙ SULLA PRIMA LETTURA — §5 punto 141
> **k = 2 letture CONSECUTIVE oltre soglia**, e consecutive vuol dire anche **contigue**: oltre
> **120 s** fra una lettura e l'altra il contatore riparte da capo, perché una lettura persa non può
> fare da ponte. Una lettura **rientrata** azzera; una lettura **non calcolabile** azzera anche lei —
> «non ho letto» non può confermare che la perdita persisteva.
> **Le soglie NON sono state toccate**: restano −5% e −$30. Si chiede solo che la perdita **sia ancora
> lì trenta secondi dopo**. Costo: **un solo giro di ritardo** su uno scatto vero.
> **⚠ VERIFICA RETROATTIVA su 7.213 letture / 5 giorni, rigiocate con le funzioni VERE: con k=2 gli
> scatti passano da 2 a ZERO.** Ed **entrambi erano falsi positivi**, con evidenza indipendente:
> il 09/08 la lettura precedente diceva **+$10,85** e quella successiva alla ripresa della misura
> (12/08) **+$2,54**, contro i −$39,97 dello scatto; il 13/08 la lettura on-chain 37 minuti dopo dava
> **−$6,77** contro i −$36,15. ⚠ Il replay **da solo** non potrebbe dirlo — dopo il latch il guardiano
> smette di misurare, quindi «0 scatti» è un limite inferiore: sono le letture *intorno* a chiudere la
> questione.
> **Il pre-allarme si vede**: ogni prima lettura oltre soglia finisce nel log come
> `PRE-ALLARME (1/2)`, o la modifica sembrerebbe «il guardiano non vede più niente».
> Lo stato vive **nel processo e non su disco**: un riavvio lo azzera, ed è giusto — un guardiano
> appena rinato non ha visto il campione precedente e non può affermare che la perdita persisteva.

> ## 📉 LA SENTINELLA SUL COLLASSO DELLA COPERTURA — §5 punto 142, SOLO OSSERVA
> Chiude §5.2 p.9. **Calo ≥ 85% dal MASSIMO delle ultime 10 minuti**, non differenza fra campioni
> consecutivi: la cadenza è irregolare (mediana 60,0 s, q99 65,3, max 77,2 su 7.859 intervalli) e un
> crollo che arriva in due campioni verrebbe **spezzato in due pezzi** ciascuno sotto soglia.
> **La soglia viene dalla tabella, non dall'intuito** (4,1 giorni, 7.860 campioni): 30% ⇒ 5 veri/183
> falsi · 40% ⇒ 5/69 · **50% ⇒ 5/20** · 60% ⇒ 5/4 · 70% ⇒ 5/2 · **80% ⇒ 5/0**. Si sceglie **85 e non
> 80 perché il divario è VUOTO**: fisiologico massimo **75%** (30 → 8, rientrato da solo in 9,5 min),
> patologico minimo **92,9%** (28 → 2), e fra i due non cade nessun episodio. 85 è il punto medio.
> **⚠ NON SI AUTO-INGANNA**: il collasso più grande nei dati **l'ha prodotto il guardiano**. Se il
> latch (`data/guardian-state.json`, campo `at` — lo scrive il guardiano stesso) porta uno scatto nei
> **15 minuti** precedenti, il calo è **SPIEGATO** e non si arma: si logga `SOSPESO` con il calo
> comunque misurato. Latch illeggibile ⇒ **non si arma**: meglio muto che bugiardo.
> **⚠ IN QUESTA FASE SOLO OSSERVA**: log + giornale (`op: sentinella-collasso`,
> `outcome: collasso-oltre-soglia`, `soloOsservazione: true`). **Non ferma il bot, non cancella
> ordini, non tocca AVVIA/FERMA** — un test lo verifica **per assenza** dei campi che agirebbero.
> La promozione ad azione è una decisione dell'operatore. **⚠ Limite: 5 soli eventi positivi in 4,1
> giorni** — soglia difendibile sui dati che ci sono, campione piccolo.

> ## 🪙 LA GAMBA SORELLA SI ABBASSA DENTRO LA BANDA — §5 punto 143
> Il Livello 2 prezzava il completamento **sempre al tetto della coppia**, e `fuoriBanda` era calcolato
> e solo **dichiarato**. Quando il tetto cade **sopra** il bordo alto della banda premiante si può
> **abbassare** fino al bordo, e conviene **due volte**: la controparte **costa meno** (il margine
> della coppia cresce) e l'ordine **matura reward mentre aspetta** invece di essere capitale fermo.
> L'unico prezzo è il **tempo di fill**, ed è lo scambio che l'operatore ha scelto esplicitamente: «a
> parità di condizioni, il prezzo dentro la banda invece di quello che chiude prima».
> **⚠ NON ALLENTA NIENTE, per costruzione**: è un `Math.min`, quindi il prezzo può solo **scendere**.
> Tetto della coppia intatto, «mai primo sul libro» intatto (l'esenzione è quella già esistente e non
> si allarga), size intatta. Banda non leggibile, o bordo **sopra** il tetto ⇒ prezzo **identico a
> prima**. Il ritardo di fill è coperto dalla scala di urgenza (§138) e dalla chiusura forzata a 3 ore.

> ## ⏱ LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA — §5 punto 138
> **Il fatto**: una posizione NO di 58,8 share è rimasta scoperta **8,2 ore**. Nessuna singola regola
> aveva sbagliato, e il bot **adattava anche il prezzo** (11 prezzi su 17 mid distinti). Sbagliava il
> **sistema** in un punto solo: **nessuno guardava da quanto tempo la posizione era scoperta** — la
> gerarchia di §4.6 ha **un solo orologio**, i 60 min del Livello 2.
> **Le soglie vengono dai dati, e la distribuzione è BIMODALE** (24 episodi, 48 h): **7 chiusi**, mediana
> **10,5 min** — contro **17 aperti**, mediana **126,5 min**, massimo 553,7. Una scopertura sana si
> chiude in dieci minuti; oltre l'ora non si chiude quasi più da sola.
> **La scala** (`lib/maker/urgenza-scoperto.js`, puro): **0** (<30 min) niente · **1** (≥30) l'uscita può
> scendere **fino al carico** (`profitPct: 0`) · **2** (≥120) **chiusura peggiorativa** entro il tetto ·
> **3** (≥240) **anomalia grave** nel log, che **non apre una quarta via**: al gradino 2 sono già tutte
> aperte, e il bot dichiara di non farcela invece di tacere.
> **⚠ IL TETTO DI PERDITA È DOPPIO E IL PIÙ STRETTO VINCE**: **2 tick** e **mai oltre il 5% del carico**
> (su un token da 10¢ due tick sarebbero il 20%). Misurato: **$0,59 su 58,8 share** contro un'esposizione
> direzionale di **$25,28**, cioè **43×**.
> **⚠ NESSUNA REGOLA DI RISCHIO È TOCCATA**: il modulo non produce prezzi, produce un **pavimento**; il
> prezzo lo sceglie il motore, che applica «mai primo» come sempre. E la concessione **non esce dalla
> banda**. **⚠ OROLOGIO NON LEGGIBILE ⇒ GRADINO 0.** **⚠ L'orologio si azzera a ogni nuovo ingresso in
> modalità chiusura**: sul caso reale diceva 168 min contro 492 veri — **sbaglia per difetto**.

> ## 🧱 I RESIDUI SOTTO IL MINIMO NON HANNO UNA VIA D'USCITA — §5.2 p.1, §5-bis p.123, BUCO APERTO
> **$26,30** in cinque residui che il registro raccoglie correttamente e che **niente può chiudere**:
> `manca` è sotto `min_incentive_size`, quindi né un ripiazzamento né il completamento della coppia
> sono ordini validi. Non è capitale perso: è **capitale irraggiungibile fino alla risoluzione**.
> La proposta — riscattarli via `redeemPositions` — è scritta e **non implementata**: è capitale, e la
> decisione è dell'operatore.

---

---

## 1 · STACK E INFRASTRUTTURA

Bot di **liquidity rewards su Polymarket**: piazza ordini maker *fermi* dentro la banda premiante e
incassa i premi di liquidità del venue. I reward si pagano sugli ordini **a riposo**, non sui fill —
per un maker l'esecuzione è il costo, non il ricavo.

| | |
|---|---|
| Runtime | Next.js 14.2 (App Router) · Node v20.20.2 · TypeScript |
| DB | Prisma 5 → **PostgreSQL** (`DATABASE_URL` in `.env`) |
| Processi | **pm2**, **40** processi definiti in `agents/ecosystem.config.js` (erano 42: `agent35-maker` e `agent37-maker-watchdog` sono stati rimossi il 9 agosto 2026 — §5 punto 63); **10 online** una volta eseguiti i due `pm2 delete` in attesa, uno (`agent44-audit-scoperta`) schedulato e a riposo, gli altri deliberatamente fermi (commit `47ff87e`: «riduzione all'insieme minimo») |
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

### I due interruttori, e chi decide cosa

Erano tre. **ARM / DISARM è stato rimosso il 9 agosto 2026** (§5 punto 63) insieme al motore che lo
consultava: era un'autorizzazione di sessione con TTL e cap di collaterale, e l'unico processo che la
leggeva era `agent35-maker`. Restano i due che decidono davvero.

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

### Permessi della sessione (stato al 7 agosto 2026, ~23:05 UTC)

`.claude/settings.json` (progetto) e `~/.claude/settings.json` (utente) portano una **copia identica**
della stessa policy: `allow` ampio + **164 regole `ask`**. `ask` batte `allow` da qualunque file arrivi,
e le regole si **fondono** fra i file. `.claude/settings.local.json` deve restare privo di regole `ask`.
Le due copie vanno tenute in sync: se ne modifichi una, modifica l'altra — e
`lib/safety/policy-permessi.test.js` fallisce se divergono.

> **NOTA DEL 9 AGOSTO 2026 — la policy NON è stata toccata dalla rimozione dell'arming.** Le regole che
> nominano `agent35-maker`, `/api/maker/{arm,disarm}` e `maker-arming` sono rimaste tutte al loro posto,
> e da oggi non possono più corrispondere a niente. Sono state lasciate **di proposito**: toglierle è
> l'unica operazione di questa pulizia che *allenta* un presidio, e §2 regola 2 dice che §2 non si
> riscrive senza istruzione esplicita. Restano anche i segnali dell'hook e `policy-permessi.test.js`
> (che le conta): il test è verde, e il costo di tenerle è zero prompt in più su comandi che non esistono.

Le regole `ask` si dividono in **tre famiglie, con criteri diversi**, e la differenza è voluta:

1. **Capitale reale — `ask` anche in lettura.** Ordini manuali (`/api/maker/manual/*`), script di
   piazzamento, `node agent40-manual-reprice` (e `agent35-maker`, che non esiste più), armamento
   (`/api/maker/{arm,disarm}`, rimosso) e gli env che abilitano il piazzamento (`MAKER_PLACEMENT`,
   `MANUAL_ORDER_PLACEMENT`, `MAKER_MODE=live|on`, `MAKER_FUNDING_APPROVED`). Qui basta *nominare* la
   cosa per far scattare il prompt: massima cautela, anche a costo di chiedere su un `grep`.
   **Questa famiglia non si allarga.**
2. **pm2 — `ask` anche solo se nominato** (dal 7 agosto 2026): `restart`, `stop`, `delete`, `reload`,
   `kill`, `startOrRestart`. Prima non c'era **nessuna** regola su pm2: la regola 2 di §2 viveva solo
   in questo file, e un riavvio poteva partire muto. `pm2 list/describe/env/logs` passano.
3. **Flag di stato/sicurezza — `ask` solo in scrittura** (dal 7 agosto 2026). AVVIA/FERMA
   (`bot-enabled`, `impostaBot`, `api/maker/bot`), KILL (`safety-kill`, `kill-maker`,
   `/api/maker/kill`), il guardiano delle perdite (`guardian-baseline`, `guardian-state`), la gestione
   manuale per mercato (`maker-manual-mode`) e il file di armamento (`maker-arming`, oggi inesistente)
   non hanno una regola-ombrello sul nome. Al suo posto c'è, per **ognuno** di questi sei flag, la stessa famiglia di
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

**Online al 7 agosto 2026** (`pm2 list` — verificato, non assunto), **meno i due rimossi il 9 agosto
2026**: `agent35-maker` (il motore automatico) e `agent37-maker-watchdog` (il suo dead-man) non sono
più nel repo né in `ecosystem.config.js`. Finché non vengono eseguiti i due `pm2 delete` in attesa
(§5 punto 63) i processi restano vivi in memoria con il codice vecchio, e `pm2 list` li mostra ancora.

| pm2 | Cosa fa | File |
|---|---|---|
| `agent34-clob-ws` | Feed **websocket** dei book CLOB Polymarket. Sola lettura, canale pubblico e senza chiavi: non può firmare, piazzare o cancellare nulla. Alimenta tape e mid-history. | `agents/agent34-clob-ws.js` |
| `agent38-tape-watchdog` | Watchdog di **continuità** dei giornali (trade tape + mid-history): copre il buco che l'auto-heal del socket di agent34 non vede. | `agents/agent38-tape-watchdog.js` |
| `agent40-manual-reprice` | **Riprezzatura / uscita dalla banda** per gli ordini piazzati a mano: l'asse giusto non è la scadenza a 180 s ma «l'ordine è ancora dentro la banda che paga?». Scrive lo snapshot posizioni. | `agents/agent40-manual-reprice.js` |
| `agent41-realloc-scheduler` | **Riallocazione periodica** (ogni 6 h) + **trigger a capitale fermo** (ogni 2 min, dall'8 agosto 2026). Il ciclo fisso ha due trigger indipendenti: *validità* e *valore*. Il trigger event-driven ne ha uno solo: c'è collaterale libero sopra **$50**. **È l'unico processo che può cancellare e piazzare ordini veri senza conferma umana**, per eccezione esplicita dell'operatore (3 agosto 2026). | `agents/agent41-realloc-scheduler.js` |
| `agent42-watch-makers` | Monitor dei **21 maker di riferimento**: ingressi, convergenze, ritiri pre-risoluzione. L'unico processo della flotta che **non può toccare capitale nemmeno in linea di principio** (nessun import da `lib/maker/`, nessuna credenziale). | `agents/agent42-watch-makers.js` |
| `agent24-liquidity-rewards` | Scanner dei mercati con reward: ogni 15 min legge Gamma + book e assegna il punteggio con la formula quadratica esatta del venue. | `agents/agent24-liquidity-rewards.js` |
| `agent27-news-guard` | Guardia notizie/volatilità: segnala che il prezzo sta per muoversi, così le quote si ritirano prima del fill avverso. | `agents/agent27-news-guard.js` |
| `agent43-guardian` | **Guardiano delle perdite economiche** — vedi la scheda sotto. In servizio dalle 21:27:31 del 7 agosto 2026 (allora col nome `agent42-guardian`), baseline **$660,56**, nessuno scatto. **Rinominato l'8 agosto 2026: il processo pm2 vivo porta ancora il nome vecchio finché non lo si ricrea — §5 punto 15.** | `agents/agent43-guardian.js` |
| `agent45-osservatore` | **L'osservatore muto** (13 agosto 2026). Un campione ogni **60 s** in `data/osservatore/`: ordini a riposo, mercati con posizione (coppie vs gambe nude), posizioni e valore, saldo, totale, PnL del guardiano, stato degli interruttori, reward di giornata. Più un **giornale in italiano** con gli eventi: pre-allarme, scatto, collasso, transizioni coperta⇄scoperta **con la durata**, merge, cancellazioni. **Non decide, non agisce, non avvisa.** Rotazione giornaliera, 30 giorni. Strutturalmente incapace di toccare capitale — un test cammina il suo albero dei `require`. **Read-only ⇒ riavviabile senza conferma.** | `agents/agent45-osservatore.js` + `lib/osservatore/campionamento.js` |
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
| `agent43-guardian` | **Il guardiano delle perdite economiche.** Ogni 30 s confronta (saldo pUSD + posizioni al prezzo corrente) con il **riferimento a massimo mobile** in `data/guardian-baseline.json` (§5-bis p.157: depositi e prelievi sono riconosciuti come cassa esterna, non come P&L); oltre `GUARDIAN_LOSS_PCT` (5%) o la **soglia assoluta DERIVATA** (5% del riferimento; `GUARDIAN_LOSS_ABS` resta il pavimento in dollari) cancella **tutti gli ordini a riposo**, deposita un referto `reason='guardian-auto-kill'` e mette il bot su **FERMA**. Non tocca le posizioni aperte e non ferma l'uscita automatica. Nessun auto-riarmo: si riparte cancellando `data/guardian-state.json` a mano. Le soglie si rileggono da `.env` **a ogni giro**, senza restart. Strutturalmente incapace di piazzare (unica superficie: `lib/maker/cancel-all`), verificato da un test che cammina l'albero dei `require` (65/65 verdi). File: `agents/agent43-guardian.js` + `lib/maker/guardian-perdite.js`. Codice e blocco pm2 sono in git dal 7 agosto (`dbba34e`). |

Distinzione che era da tenere ferma, e che il 9 agosto 2026 ha perso una delle due metà: **agent37
guardava i processi, agent43-guardian guarda il capitale** — due guasti indipendenti (un motore può
battere regolare e perdere soldi), quindi due processi. Con la rimozione di agent37 **resta solo il
secondo**, e va detto per intero: **oggi nessun processo sorveglia il battito di agent40**. Se agent40
si blocca con ordini a riposo, ciò che li toglie è la scadenza **GTD nativa** del venue
(`lib/maker/order-ttl.js`) e, per la parte economica, agent43-guardian se la perdita supera la soglia.
Era la copertura dichiarata anche prima per la morte dell'host; da oggi vale anche per la morte del
solo processo. **È una conseguenza voluta della rimozione, non un difetto scoperto dopo** (§5 punto 63).

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

---

## 4 · STATO ATTUALE DEL SISTEMA

Bot di **liquidity rewards su Polymarket**: piazza ordini maker *fermi* dentro la banda premiante e
incassa i premi di liquidità. **I reward si pagano sugli ordini a riposo, non sui fill** — per un maker
l'esecuzione è il costo, non il ricavo. Ogni numero qui sotto è letto dal codice/stato reali.

### 4.1 · Il motore di piazzamento — `lib/maker/motore-unico.js`

Un profilo solo dal 6 agosto 2026 (Safe/Risk aboliti: la formula del venue è una curva continua e non
conosce bucket; nessun `if (profilo)` nel repo). **Le cinque regole, nell'ordine in cui si applicano:**

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

**Fine scala**: sotto 3¢ o sopra 97¢ un mercato sta risolvendo e non si quota (`end-of-scale.js`,
soglie da `.env` rilette a ogni chiamata; un valore che non si capisce viene **scartato** in favore del
difetto — un `.env` sbagliato non può spegnere una protezione). La chiamano quattro moduli.

**Mid stantio**: oltre **20 s** di cecità l'ordine si **cancella** (`mid-stantio.js`, env con clamp
`[5 s, 120 s]`). L'orologio si azzera **solo su una lettura buona**, e una cancellazione fallita NON lo
azzera. Tre cause distinte in audit — `cecita-timeout-{mid-stantio|nessun-libro|eta-ignota}` — perché
l'azione è la stessa ma la diagnosi no.

**Cadenza di reprice adattiva per mercato** (`cadenza-adattiva.js`): l'escursione del mid su 15 minuti
si traduce in tick/ora e da lì in tre classi — veloce 1 s, media 5 s, lenta 10 s. Chiamate al venue
−37,9%. **Non abbassa nessuna soglia**: `minMoveCents`, `hysteresisTicks`, `confirmSamples` e
`minIntervalMs` restano dov'erano, e guardare più spesso non riprezza di più. Misura assente ⇒ cadenza
di difetto. La decisione è guidata anche dall'**istante dell'ultimo book**, così un mercato «lento» col
book appena cambiato non aspetta dieci secondi.

### 4.2 · I tetti di capitale — `lib/rewards/concentration.js`, UNA fonte, importata

**Nessun numero cablato: il tetto DERIVA da `f_min`.**

```
tetto per mercato = pavimentoPremiante(SCAGLIONE_FINANZIABILE) = 50 × 0,98 × 1,25   = $61,25
                    ⇒ f_min NON è più l'ingresso: è la conseguenza, e vale 0,32
tetto per ordine  = tetto/2 + $5                                                     = $35,63
pavimento premiante(minSize) = minSize × 0,98 × 1,25   ⇒ 20/50/100/200 = $24,50/$61,25/$122,50/$245
```

- **Il numero di mercati è una CONSEGUENZA** (`capitale ÷ tetto`), non un parametro: quando il capitale
  cresce si spalma su **più mercati**, non si ingrossa la size su ciascuno. Una frazione pura
  (`tetto = C×k`) fa esattamente l'opposto ed è stata scritta e buttata (§5 p.107).
- `capPerMarketUsd(capitale)` **non restituisce mai `null`** (a valle varrebbe «nessun tetto», il
  fail-open della vecchia versione a percentuale) e può solo **stringere**: si clampa al capitale.
- **Undici consumatori lo IMPORTANO**, nessuno lo ridichiara: pianificatore/knapsack, motore (Regola 5),
  `decideRimpiazzo`, punteggio di rischio, adapter, corsia manuale, … `netto-centralizzato.test.js`
  verifica gli import **per nome**, e il rilevatore **D1** dell'audit sorveglia `MARKET_CAP_FIXED_USD`.
- **Un mercato sotto il pavimento premiante NON si quota**: sotto `min_incentive_size` il reward è
  **ZERO**, non più basso. Meglio meno mercati sopra soglia che tanti sotto.
- **⚠ Il tetto NON si può alzare per diversificare** (§5 p.117): dei 323 mercati del board solo **50**
  hanno `minSize 20` (l'unico scaglione sotto $32,67) e **49 sono meteo**; i 196 a `minSize 1000`
  chiedono $1.225 per mercato. A `f_min` 0,32 i mercati passabili **CALANO** da 21 a 18, perché `Q`
  cresce col tetto mentre il margine di $5 sul tetto per ordine resta fisso e la **finestra di mid si
  stringe**. La leva è più capitale, non una manopola.

**Tetto di ordini per finestra** (`data/safety-risk-limits.json`): **40 invii / 60 s**, con **quota
60/40** — al più 24 posti alle aperture, **16 riservati a rinnovi e chiusure protettive**. Invariante
difesa da un test: `rateCap ≥ 2 × mercatiPerGiro` con almeno 8 posti di margine. Un'apertura rimandata
è un **rinvio dichiarato** (`rimandato-per-quota`), non un errore. Restano intatti il cap per ordine di
safety ($1000) e il cap cumulativo di esposizione aperta ($600). **Mercati per giro: 10** (era 12 — 13 agosto 2026), dichiarati in
**un posto solo** (`utilizzo-capitale.leggiMaxNuoviPerGiro`) e importati dal trigger.

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
| **orizzonte** | `horizon.js` | `[MIN_HORIZON_DAYS **0,50** · MAX_HORIZON_DAYS 150]`, confini **inclusivi da entrambi i lati**. Il pavimento in ore (**12 h**) è **derivato** in `market-validity` e in `risk-classifier`, non ripetuto. **0,75 → 0,50 il 13 agosto 2026**: il confine di rischio misurato è a **6 ore** (sotto, il 35,1% delle uscite arriva dopo la risoluzione; fra 6-12 h è 0/36, fra 12-18 h 0/15), quindi a 12 h restano **due volte** il margine. **0,25 g è sconsigliato.** Sul board vivo: utilizzabili **13 → 50**, coperti **13 → 35**, capitale impiegato **$796 → $2.144**, reward modellato **5,14×**. **Scadenza non determinabile ⇒ ESCLUDE**. ⚠ **È il filtro che taglia di più**: 78 mercati su 102 valutati il 13/8 alle 20:17, e il gradino è tutto fra 12 h e 18 h — vedi §5 punto 129 prima di toccarlo o di lasciarlo com'è |
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
**allargava un limite di rischio** (il tetto è una frazione del totale).

`misuraDopo` **non accetta più il saldo come parametro**: l'errore non è più esprimibile.
`riconcilia()` ferma il giro (`fermato-capitale-incoerente`) se due letture del saldo divergono oltre
**max(2%, $5)** — relativa perché su conti grandi $2 non sono niente, assoluta perché su conti piccoli
il 2% è rumore. **Una lettura mancante non è una lettura concorde**, ma nemmeno una divergenza: se la
misura non è leggibile non si confronta e si prosegue col saldo del trigger.

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

**La gerarchia del merge, senza scorciatoie.** `completaCoppia` è chiamata da **tutti** i rami di
`runAutoCloseCycle` — `already-covered`, `close-at-market`, uscita ordinaria e **`skip`** (§5 p.110) —
tranne i tre in cui manca un ingresso (`no-position`, `no-entry-price`, `rules-unreadable`), che lo
**dichiarano** (`merge-saltato-senza-ingressi`) invece di tacere.

| # | stadio | tetto |
|---|---|---|
| 0 | **merge on-chain** se la coppia è già completa | rende **$1/share subito**, gas del relayer, zero slippage |
| 1 | Livello 1 — taker sull'altro lato | coppia ≤ **99¢** |
| 2 | Livello 2 — maker a riposo, attesa 60 min, **bersaglio su disco**; ai cicli dopo si **aggiunge** la differenza, mai si sostituisce l'ordine vivo (aprirebbe una finestra di scoperto totale) | coppia ≤ 99¢ |
| 3 | chiusura rapida: taker fin dove il book copre + limit per il resto | coppia ≤ **120¢** |
| 4 | riposizionamento scoperto: SELL a **+1% dal carico**, dentro banda e **mai sotto il carico**, + BUY sulla controparte | coppia ≤ 120¢ |

**Un obbligo di esito** si apre nella stessa istruzione che scrive la decisione e va chiuso: due punti di
flush che nessun `continue` può saltare, e `merge-esito-mancante` per chi sfugge. **Ogni** esito di
`registraCoppia` scrive una riga, `non-applicabile` e `in-attesa` compresi.

**Tetto della coppia 120¢**: è il costo massimo che si accetta di pagare **per non restare direzionali**
— l'alternativa non è zero, è un'esposizione il cui esito peggiore vale 100¢/share. **Il tetto del merge
(99¢) è un'altra cosa e non si è mosso**: quello dice se completare la coppia è *profittevole*, questo
se è *accettabile*. Il valore si asserisce in **un punto solo**; gli altri undici test lo **derivano**.

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
si legge da **board ∪ catalogo di ripiego ∪ venue** (§5 p.122). Una coppia **completa** non si forza:
alla risoluzione vale $1 comunque.

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
starebbe nel periodo a quel ritmo. `REWARD_MAX_CLOB_MARKETS = 150` — **è già il massimo**: 2,74-3,91
s/mercato misurati, e il vincolo è `tempo_scansione < periodo`; al ritmo peggiore il valore corretto
sarebbe più **basso**. `ETA_BOARD_MAX_MS = 25 min` sta sopra il periodo ma sotto il doppio, così una
scansione saltata per intero resta visibile.

**⚠ Il costo di una scansione si stima sugli elementi che PROCESSA, non su quelli che sopravvivono ai
filtri a valle**: fra i due numeri c'era un fattore **3,5** e bastò a fermare il capitale (§5 p.53).
E quando un numero governa una finestra temporale si tara su un **cronometro**, non su un'aritmetica.

**La scadenza ha una fonte sola: il venue**, col board come riscontro. Il CLOB **tronca a mezzanotte
UTC**, quindi è per costruzione mai più tardi di Gamma — la più prudente, e il registro di chi smette
davvero di accettare ordini. Divergenza > 24 h, o Gamma prima del CLOB > 1 h ⇒ mercato **escluso a
monte** (`scadenza-discorde`); una lettura **mancante** invece non esclude — le due direzioni di
fallimento sono opposte apposta. **Quando il troncamento è DIMOSTRABILE**
(`troncaAMezzanotteUTC(gamma) === clob`) si usa l'ora vera di Gamma
(`gamma-ora-vera-su-clob-troncato`): è una **prova**, non tre indizi, e distingue da sola il caso delle
24 h esatte, che nessuna clausola scritta a mano coglierebbe.

**Il feed di agent34 non è più un anello chiuso** (§5 p.119): `allocator` scarta i mercati a profondità
`non-verificata`, e la verifica accetta **solo** campioni websocket — ma il websocket sottoscriveva
`collector-priority.json`, che agent41 scriveva **dal proprio piano**. Adesso il feed si semina anche
con i **CANDIDATI** (minSize compatibile col tetto *di adesso*, letto dal capitale vero, + orizzonte
≥ 18 h) e con i mercati con **posizione aperta**. Tetto della corsia **60**. Ordine di sacrificio:
righe del piano → quasi-vincitori → trattenuti → **candidati per primi** (un candidato è un'ipotesi, una
riga del piano è capitale deciso). Board illeggibile ⇒ zero candidati.

### 4.8 · La regola di copertura, applicata in SEI punti

«**Board ∪ mercati dove il capitale è già esposto**, mai solo il board.» **Una** definizione
(`auto-reprice-config.liveMinMarketIds`), sei consumatori: gate live-min · sottoscrizione del book ·
composizione del board (`rewards-normalize`) · lista dell'uscita automatica · scope del rinnovo ·
catalogo di ripiego. **Non allarga il perimetro di rischio**: aggiunge solo mercati dove il capitale è
**già** dentro — non apre un mercato nuovo, apre la *gestione* di una posizione che esiste.
Fail-closed ovunque, e subordinata all'interruttore generale.

**⚠ Resta scoperta una metà, ed è dichiarata**: l'unione è `abilitati ∪ posizioni` perché **non esiste
uno snapshot locale degli ordini a riposo** (esiste solo per le posizioni). La metà «ordine a riposo» è
coperta indirettamente: un ordine su un mercato disabilitato muore per GTD entro 23 minuti o si riempie,
e allora la posizione entra nell'unione entro un giro di snapshot (≤ 60 s). Coprirla direttamente
richiede uno snapshot degli ordini, cioè un file, uno scrittore e una regola di freschezza.

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
manuale (`live-providers.makerSignerProvider`), e il controllo di coerenza chiave↔credenziali vive **in
un punto solo**, dentro il relayer. Fail-closed: `negRisk` non booleano, size non finita, flag spento o
qualunque eccezione ⇒ **non è successo niente**, e si prosegue col comportamento di prima.

**Perché lo split non conviene MAI in questa strategia** (§5 p.48): lo split rende 1 YES + 1 NO per
**$1,00** esatti; comprare le due gambe in banda costa **0,93-0,999** (mediana 0,97 su 37 coppie reali,
`pairCostUsd` 0,98 sul piano) — e quel 3% di sconto **è** il margine, perché il bot posa le gambe un
tick dietro il tocco su ciascun lato e la coppia costa `1 − 2·offset` **per costruzione**. E soprattutto
**lo split non mette niente sul libro**: due token fermi non maturano nulla, cioè non costa 3¢ in più,
**rinuncia all'intero ricavo**. L'ipotesi «conviene quando il book non offre la coppia a sconto» non si
verifica: se la coppia costasse ≥ $1 il bot **non aprirebbe** quella posizione — lo sconto *è* la
condizione d'ingresso, e perfino il Livello 1 ha un tetto a 99¢.

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
⚠ La rotazione **non si innesca sotto un `*.test.js`** (guardia su `argv[1]`): `appendMakerAudit` scrive
sempre sul file vero, e una rotazione innescata da un test è un'azione di produzione che nessuno ha chiesto.

I giornali si leggono in modo **incrementale** (`giornale-incrementale.js`): `readFileSync(…,'utf8')`
costruisce UNA stringa e V8 si ferma a ~512 MB, e a 731 MB i lettori fallivano **chiuso**. Rileva la
rotazione da **inode + dimensione + testa** (un file riscritto in place passerebbe i primi due) e
consegna anche l'ultima riga senza `\n` — cioè il record **più recente** — senza consumarla.

**Persistono su disco** (provato con `kill -9` su nove processi): attese di merge · modalità chiusura
col bersaglio della sorella · residui scoperti e sotto soglia · tetti · gestione manuale · allowlist ·
catalogo di ripiego · idempotenza · confronto reward · baseline e latch del guardiano · piano
dell'allocatore · `da-ripianificare.json`. **Nessun buco strutturale.** In memoria e perso *senza costo*:
contatori di conferma del riprezzo, insiemi anti-ripetizione dei log, cache posizioni 5 s, registro orfani.

**Origine di un ordine**: campo `origine` **accanto** a `source` (`source` dice quale corsia piazza,
`origine` dice se dietro c'era una persona). Il reset di agent41 cancella **solo** ciò che è
provatamente `auto`; manuale e **ignoto** restano sul libro. Terza origine **`auto-chiusura`**, che il
reset non tocca **per decisione**: si spazzano gli ordini automatici *di piano*, non chi sta chiudendo
una posizione. Le costanti sono **importate**, non ricopiate — era una stringa ricopiata a produrre il
difetto delle 4.686 righe etichettate male.

**Idempotenza**: chiave deterministica sull'identità economica
(`sha256(userId|venue|tokenId|side|price|size)`), **nessuna componente temporale**. Un piazzamento che
supera un ordine **morto** riceve una chiave derivata dall'id di quello che supera; la **catena** di
sostituzioni arriva a **20.000** anelli (~due settimane, ~80 ms a percorrerla). **La protezione
anti-doppio-invio non è il tetto**: è la verifica che l'ordine precedente sia morto sul venue, e vale a
**ogni singolo anello**.

**La riconciliazione dei fill confronta grandezze OMOGENEE**: il volume del venue per **token+lato**
contro quanto è già registrato per **token+lato** su tutte le chiavi (e per **id-ordine-venue** nel ramo
`size_matched`), mai contro una singola `idempotencyKey`. Altrimenti ogni ripiazzamento — uno ogni ~60 s
sulla stessa gamba — ritrova lo stesso volume e lo registra **intero** come fill proprio: §5 p.72,
2.790 share fantasma contro **zero** al venue, bot bloccato dal tetto $600 per un errore di somma.

**Il ledger si netta contro il venue**: uno snapshot `readable` che non elenca un token è **prova** che
quella posizione è chiusa (oltre `MAX_AGE_MS` `readable` è già `false`, quindi `true` significa già
«lettura fresca», e su questo venue la risposta è l'elenco completo). Assente, vecchio o illeggibile ⇒
**non si netta niente**. **Nessuna riga viene cancellata**: il ledger resta append-only e la posizione
resta marcata `chiusaAlVenue` con la sua `esposizionePrimaUsd`.

**`skipped` non sparisce dal referto**: non entra né in `placed` né in `refused`, quindi «0 piazzati, 0
rifiutati» descriveva un **blocco totale** con la stessa riga con cui descriverebbe l'inazione. Il
referto porta `saltati` e `motiviSaltati`.

### 4.11 · Backoff, rate limit, resilienza

429 ≠ 5xx: il 429 parte da 1 s e raddoppia (1→2→4), e **`Retry-After` vince** su qualunque progressione
(secondi o data HTTP, max 30 s). Dopo un esito **ambiguo** — la POST era partita — non si ritenta alla
cieca: si interroga il venue, e se l'ordine c'è l'esito è **riuscito**; una verifica che non riesce vale
«non ritentare», perché fra due ordini e zero ordini il secondo errore costa meno.

`/positions` ha **5 tentativi, 1 s → 30 s, con jitter ±25%**: senza jitter ogni lettore riparte dallo
stesso istante dopo lo stesso 429 ed è il modo di trasformare un rate-limit in un rate-limit permanente.
Un 200 con un corpo che non è una lista **non si ritenta**. **⚠ La soglia dei 180 s sullo snapshot NON è
toccata**: è la protezione che impedisce di piazzare su una fotografia vecchia delle posizioni; il
rifiuto arriva dopo i tentativi invece che al primo singhiozzo.

I **sei piazzamenti di chiusura** riprovano fino a **3 volte** (`piazzaChiudendo`), ma **solo** se a
rifiutare è il venue — un `gate` nostro non cambia fra un tentativo e l'altro, e ritentarlo sarebbe
martellare il proprio codice — e **mai su un esito ambiguo**. Il KILL si rilegge **prima di ogni
ritentativo**, non solo a inizio ciclo. **La quotazione ordinaria non riprova**: un ordine di liquidità
può aspettare il ciclo dopo, una posizione scoperta no.

**pm2**: `min_uptime: 30 s` + `max_restarts: 500` su tutti i processi critici, in **un punto solo** del
config (`RIAVVIO_ROBUSTO` + `PROCESSI_CRITICI`). `restart_delay` resta **per-agente** (6 valori
distinti: appiattirli sarebbe una regressione travestita da uniformità). ⚠ La politica diventa effettiva
solo con `pm2 restart agents/ecosystem.config.js --only <nome>`: pm2 tiene la propria copia in memoria.

### 4.12 · Stima e consuntivo

**La stima è una QUANTITÀ, non un tasso fotografato**: `Σ(tasso × durata)`, campionata ogni **5 minuti**
da agent40 con **orologio e lucchetto propri** (un confronto lento non deve far saltare campioni).
Tre regole: un campione vale al più **due passi**, uno scoperto **sottostima e lo dichiara**
(`coperturaFrazione`), un tasso non finito **non si registra**. Ricalcolo a ritroso: **+466% → +118%**.

**Il consuntivo è per GIORNO, non per mercato**: sulle righe REWARD `conditionId`, `title` e `slug` sono
vuoti (il venue paga un bonifico aggregato), e il totale **non viene diviso in proporzione** — sarebbe
un numero inventato con l'aspetto di una misura. Fonte: registro attività **pubblico** keyed sul
**funder** — le credenziali L2 sono dell'EOA, quindi era un problema di **identità**, non di endpoint.
Recupero **a ritroso** fino a 30 giorni, perché i tre tentativi notturni cadono prima che il pagamento
arrivi. Registro visibile su `GET /api/maker/registro-reward` e nella scheda «alloca».

---

## 5 · QUESTIONI APERTE

Solo voci con evidenza reale nel codice, nei commit o nei file di stato. Chiuso ⇒ si toglie di qui e
resta una riga nel registro di §5-bis.

### 5.1 · Riavvii pendenti — al 13 agosto 2026, 19:40 UTC

| processo | cosa entra in servizio | stato |
|---|---|---|
| `agent43-guardian` | **🔴 IL RIFERIMENTO NUOVO E LA SOGLIA DERIVATA (§5-bis p.157)** — finché non riparte il guardiano usa la baseline del 7 agosto e **NON PROTEGGE** | **PENDENTE — È IL PRIMO** |
| `agent40` · `agent41` · `agent24` | orizzonte 0,50 · mercati per giro 10 · manopola distanza (spenta) · tetto e banda già committati | **PENDENTE** |
| `agent41-realloc-scheduler` | **il gradino 6 «fermati-in-sicurezza» (§5-bis p.153)**: `impostaBot` cablato ⇒ l'ultima difesa esiste davvero · il log del gradino 5 leggibile | **PENDENTE — ⚠ ARMA UNA DIFESA CHE FINORA FALLIVA CHIUSO** |
| `agent41-realloc-scheduler` | **la banda premiante corretta (§5-bis p.155)** nel cablaggio e nei log del ciclo | **PENDENTE** |
| `agent40-manual-reprice` | **la banda corretta in `auto-reprice` e `auto-close`**: il giudizio «fuori banda» e la geometria dell'uscita | **PENDENTE — è il riavvio che CHIUDE la divergenza** |
| `agent24-liquidity-rewards` | la banda corretta nel punteggio del board (`scoreBook`, `halfBand`) | **PENDENTE** |
| `agent34-clob-ws` | la banda corretta nel `bandRadiusC` dei campioni di profondità | **PENDENTE** |
| `dashboard` | pannello e `/api/*`: raggio di banda, binario, testo dell'interfaccia | **PENDENTE** (build già verde) |

> ## ⚠️ LA CORREZIONE DELLA BANDA È GIÀ PARZIALMENTE IN SERVIZIO, SENZA RIAVVIO — LEGGERE PRIMA DI DECIDERE
> `lib/rewards/allocator.js`, `quotabilita.js`, `realistic-estimate.js`, `plan-to-orders.js` e le loro
> dipendenze (`rewardScore.js`, `banda-premiante.js`) vivono nel **processo figlio** del piano, che
> rilegge il codice da disco a ogni giro (§5.3). Quindi **il pianificatore usa già la banda vera**,
> mentre agent40 e agent41 in memoria usano ancora quella stretta. **Divergenza dichiarata, non scoperta.**
> **Perché non è pericolosa, e perché va chiusa lo stesso**: allargare la banda è **monotono** — il piano
> nuovo è un **soprainsieme** di quello vecchio, quindi tutto ciò che il motore accettava continua ad
> accettarlo, e i mercati in più vengono **rifiutati** dal motore vecchio (`motore-non-conforme` /
> `mai-primo-non-quotabile`). Non si apre niente che prima era vietato. **Il costo è rifiuti in più**, e
> nel caso peggiore la scala di sblocco arriva a **FERMA in ~30 minuti**, che è uno stato sicuro.
> **Il riavvio di agent40 e agent41 è ciò che rende coerenti i due lati.** Finché non avviene, il bot
> lavora sull'intersezione, cioè come prima.

I riavvii del mattino e del pomeriggio sono già in servizio: agent41 **restart 78** (12:09:01Z) e
agent40 **restart 99** (12:28:36Z) portano griglia, pavimento per riga, sentinelle, recupero scadenza,
capitale al lavoro sul piazzato, coerenza delle soglie, scala di sblocco, autodiagnosi e la scala di
urgenza di §5 p.138. **Non restano riavvii arretrati oltre a quello qui sopra.**

```bash
pm2 restart agent41-realloc-scheduler
```

> ## ⚠ QUESTO RIAVVIO NON È NEUTRO, E VA DECISO SAPENDOLO
> Fino a ora il gradino 6 moriva con un `ReferenceError` catturato: la scala arrivava in fondo,
> **dichiarava** di aver fermato il bot, e il bot restava su **AVVIA**. Dopo il riavvio quel gradino
> **mette davvero il bot su FERMA**, e **non esiste riarmo automatico**: si riparte premendo AVVIA.
> **Quante volte sarebbe scattato, misurato**: il modulo è in servizio dal **13/08 07:39:06Z**, quindi
> la finestra osservabile è **11h20m e non 48 ore** — nel giornale non esiste nulla prima.
> Gradino 6 raggiunto **2 volte**: **08:59:06Z** (falso positivo del difetto `ultimoCicloOk` di
> §5-bis p.135: capitale al lavoro **82,7%**, **28 ordini vivi** — bot sano; corretto e in servizio dal
> restart delle 12:09) e **18:52:31Z** (vero: capitale al lavoro **23,8%**, **1 ordine vivo**).
> **Sul codice di adesso: 1 scatto in 6h46m di osservazione, ed era corretto.**
> **⚠ Ma «corretto» non vuol dire «utile»**: FERMA blocca le APERTURE, e il bot non stava aprendo
> perché il piano è vuoto. Il gradino 6 trasformerebbe «prova e non ci riesce» in «dichiara di essersi
> fermato», e servirebbe una mano umana per ripartire. Finché la causa a monte resta (§5.2 p.21), è
> **verosimile che scatti di nuovo entro ore**. Lasciarlo disarmato è una scelta legittima ed è
> dell'operatore: basta non eseguire questo riavvio — la modifica è inerte finché il processo non riparte.

### 5.2 · Aperte

> **Chiuse oggi, e scese a una riga** (diagnosi integrale in §5-bis e in `git log`):
> **p.15/16 guardiano k=2 + letture distinte** → §5-bis p.141 e p.145 · **p.17 registro residui senza
> consumatore** → p.148 · **p.18 tetto per ordine sul riposizionamento scoperto** → p.147.

26. **🟡 `end-of-scale` NON è stata stretta a [0,10 · 0,90], e la ragione è misurata (13 agosto 2026).**
   La proposta: allineare la nostra soglia ([0,03 · 0,97]) al punto dove il venue rompe `Q_min`, perché
   fuori da [0,10 · 0,90] una gamba **nuda** matura ZERO invece di un terzo.
   **⚠ MA QUELLA PROTEZIONE ESISTE GIÀ, ED È PIÙ PRECISA**: `motore-unico.latoSingolo` deriva la
   frazione da `qMin` stesso (`MID_MIN_UN_LATO = 0,10`, `MID_MAX_UN_LATO = 0,90`) e **cancella** un lato
   solo fuori banda — **48 volte in produzione** nel giornale corrente. Stringere `end-of-scale`
   impedirebbe di quotare **a DUE lati** dove il venue paga normalmente (`Q_min = min(Qb,Qa) > 0`), cioè
   toglierebbe reward senza aggiungere protezione.
   **Il costo misurato**: 11 mercati del board nella fascia contesa, di cui **5 davvero utilizzabili**
   per **$666/g di montepremi**; nel piano dei migliori sono **4 mercati per $62,33/g modellati (17,8%)**,
   e i rimpiazzi che entrerebbero valgono **$4,28/g**. Misura in `data/ricerca/fine-scala-1090.json`.
   **Decisione: non applicata**, e la seconda ragione è metodologica — l'orizzonte si è appena mosso, e
   due leve insieme rendono illeggibili le 24 ore di dati che l'operatore ha chiesto.


21. **🔴 IL PAVIMENTO DI PROFONDITÀ TRATTA UN RINNOVO COME UN'APERTURA — difetto annotato, NON
   corretto (13 agosto 2026, sera).** Stessa forma dei due chiusi stamattina (§5-bis p.133 tetto per
   mercato, p.147 tetto per ordine): una regola nata per limitare l'**apertura** di esposizione nuova,
   applicata a un'azione che non apre niente. `pavimentoDepth`
   (`lib/maker/motore-unico.js:105-146`) non riceve nessun flag di chiusura; `motore-unico.js:208`
   scarta il livello; `motore-unico.js:218` è il messaggio; `auto-reprice.js:1576` passa al rinnovo lo
   **stesso** `pavimentoUsd` di un'apertura; e `tetto-chiusura.test.js:114-117` **asserisce l'assenza**
   — quando §5-bis p.133 esentò le chiusure dal tetto, il pavimento fu lasciato fuori di proposito.
   **Il caso vero**: Austin `cid_8951311347`, gamba **YES BUY 0,44 × 32,6 = $14,34** (una delle due di
   una coppia delle 12:30:06), **13:13:13 `SCADUTO SENZA RINNOVO` — «il rinnovo era DOVUTO e l'ha
   fermato "motore-non-conforme: profondita-insufficiente: la banda finisce prima del pavimento:
   $43,12 su 1 livelli contro $186,44"»**. Da lì il mercato è rimasto **a gamba singola per oltre 5
   ore**: esposizione direzionale **prodotta da un filtro anti-rischio**.
   **⚠ L'analogia non è perfetta e non va forzata**: l'esenzione sul tetto poggiava su una prova
   aritmetica (un BUY limitato da `manca` può solo appaiare). Qui no: rinnovare su un book sottile
   lascia davvero capitale a riposo su un book sottile. Ma il termine di paragone non è «nessuna
   esposizione», è **«la sorella muore e restiamo direzionali»**. Serve una decisione dell'operatore su
   quale prova renda l'esenzione sicura *per costruzione*, non un `if` aggiunto a occhio.
   **⚠ Strumentazione mancante**: dei 1.160 `profondita-insufficiente` in 2 ore non è possibile sapere
   quanti fossero rinnovi e quanti aperture — il record di rifiuto del motore **non porta un campo che
   distingua i due casi**. Andrebbe scritto lì.
22. **🟡 IL PIANO SI SVUOTA, E LA CAUSA MISURATA NON È IL FILTRO DI PROFONDITÀ** (13 agosto 2026, sera;
   misura completa in `data/ricerca/sintesi-profondita.md`, script `scripts/ricerca/taratura-profondita.js`).
   Sul board vivo l'imbuto è: **111 sul board → 102 con profondità misurata → 46 FINANZIABILI → 41 che
   passano q=0,60**, contro **16 minimi** per coprire il capitale. **Il cancello che toglie 56 mercati
   su 102 è `pavimentoPremiante(minSize) > tetto per mercato`** (`$61,25 / $122,50 / $245` contro
   **$32,67**), non la profondità, che ne toglie 5. **La leva è più capitale o un tetto più alto, ed è
   §4.2 / §5-bis p.117 e p.132 — già scritto, e questa misura lo conferma sul board di oggi.**
   ⚠ Il «superstiti 2 contro 16 minimi» del log di agent41 è reale ma riguarda il **piano ristretto**
   (`agent41-realloc-scheduler.js:561`, ramo `onlyMarketIds`), calcolato sui soli mercati già in
   gestione — non sul board. **Perché il ristretto scenda a 2 NON è misurabile dallo stato salvato**: è
   la lacuna di §5.2 p.10, i candidati scartati non sono persistiti da nessuna parte.
1. **I RESIDUI SOTTO IL MINIMO NON HANNO UNA VIA D'USCITA — buco strutturale, §5-bis p.123.**
   **$26,30** in cinque residui che nessun percorso può chiudere. Proposta scritta, **non implementata**
   perché è capitale: è una decisione dell'operatore.
2. **`REALLOC_SCHEDULER_DRY_RUN` vive nella descrizione in memoria di pm2**, non nel dump né in `.env`.
   Oggi vale `0` (freno disinserito) ed è **letta davvero**. `--update-env` **fonde**, non sostituisce:
   una chiave entrata una volta sopravvive a ogni riavvio. L'unica rimozione possibile è
   `pm2 delete` + `pm2 start`. **Non farlo** senza istruzione: azzera i contatori e lascia agent41 giù
   se lo `start` fallisce.
3. **L'header di `lib/maker/strategia-merge.js` è invecchiato**: elenca quattro ragioni per cui il merge
   «non è eseguibile», e il relayer ne ha tolte tre, `ctf-relayer` la quarta. Solo un commento.
4. **Nessun processo sorveglia il battito di agent40** (agent37 rimosso il 9 agosto, conseguenza voluta).
   Se agent40 si blocca con ordini a riposo, a toglierli restano la **scadenza GTD nativa** del venue e,
   sul lato economico, `agent43-guardian` oltre la soglia di perdita.
5. **La ricostruzione del piano non conosce lo scope del rinnovo**: `auto-reprice` itera
   `cfgState.enabledMarketIds`, quindi un mercato fuori dal piano non viene visitato e i suoi ordini
   muoiono per GTD in 23 minuti. **È una decisione documentata**, non un difetto — ma è anche il motivo
   per cui il controllo della gamba orfana non si esercita su quei mercati.
6. **`controlloCapitaleFermo({forzatoDa})` ha di nuovo un chiamante**: la sentinella sul vuoto. Il
   parametro era rimasto senza consumatori dopo §5-bis p.105.
7. **La ricostruzione sotto soglia scatta quasi a ogni giro sul board di oggi** (6 righe utili contro
   una soglia di 12): costa ~13 s di processo figlio ogni 10 minuti. È il comportamento corretto — il
   piano *è* sotto soglia — ma se un domani il board si allargasse stabilmente vale la pena rimisurare.

13. **La soglia sulla derivata per la sentinella È misurabile, ed è l'85%** (§5-bis p.140). Non
   implementata: questa era una sessione di sola diagnosi.
24. **⚑ IL MERCATO È CALIBRATO AGLI ESTREMI — misura, 13 agosto 2026.** Universo: **mercati**, non
   trader, quindi senza la selezione che invalidava §5-bis p.151. Gamma `closed=true` **partizionato
   per finestre di `end_date`** (⚠ Gamma tronca a ~3.000 record per query: senza partizione si copre
   meno di UN giorno) + `clob/prices-history` a **24 h prima di `endDate`**, volume ≥ $2.000.
   **2.293 mercati raccolti, 1.248 con prezzo utilizzabile** (1.045 senza storia nella finestra:
   scartati, non approssimati). Scadenze da **2026-05-16** a oggi.
   **Aggregando per superare le 200 osservazioni** — le fasce strette non le concludo:
   `0,95–1,00` **n=819, 99,39% contro 99,21% atteso, +0,18 pt (±0,53)** ⇒ **CALIBRATO**;
   `0,97–1,00` n=750, 99,60% contro 99,51%, +0,09 (±0,45) ⇒ **CALIBRATO**;
   `0,90–1,00` n=892, 98,54% contro 98,66%, −0,12 (±0,79) ⇒ **CALIBRATO**.
   **⚠ Fasce sotto le 200 osservazioni, NON concluse**: 0,90–0,95 (n=73, 89,0% contro 92,5%),
   0,95–0,97 (n=69), 0,97–0,99 (n=141), 0,50–0,70 (n=139).
   **EV di comprare la gamba cara**, netto di **1¢ di spread ipotizzato** (dichiarato, non misurato):
   0,95–0,97 **+0,12%** · 0,97–0,99 **−0,59%** · 0,99–1,00 **−0,98%**. **Lo spread d'ingresso mangia
   l'intero margine agli estremi**: a 0,998 l'EV lordo è +0,0002/share contro 0,01 di spread.
   **Varianza su 50 operazioni** ($1/op): a 0,99+ il 95° percentile è **1 perdita** e il PnL **−$1,41**;
   a 0,90–0,95 sono **9 perdite** e **−$6,23**, con **−$8,39** al 99°.
   **Nessuna raccomandazione**: il mercato non sbaglia sistematicamente agli estremi, e il costo è lo
   spread, non la calibrazione.
23. **⚑ QUANTO RENDEREBBE PIÙ CAPITALE — misura, 13 agosto 2026. Due risposte che NON si conciliano,
   ed è il risultato.**
   **① EMPIRICAMENTE IL REWARD È PIATTO NEL CAPITALE**: su **604 wallet** (presenti ≥5 giorni), il
   reward/giorno mediano resta **$45–112 in OGNI decile**, da **$11** a **$365.955** di capitale in
   posizione. Regressione log-log: **reward ~ capitale^0,015, R² = 0,03**.
   **⚠ MA È LA VARIABILE SBAGLIATA**: `valoreUsd` è il capitale **in posizione**, e i reward li generano
   gli **ordini a riposo**, che l'API non espone (§5-bis p.144). **La forma della curva NON è misurabile
   da questo campione.**
   **② STRUTTURALMENTE il vincolo è il BOARD, e ha una rottura netta**: `capPerMarketUsd` **scala**
   ($32,67 a $650 · $75 a $3.000 · $375 a $15.000) e `MAX_MERCATI = 40`. **Sotto ~$1.307 più capitale =
   più MERCATI**; **sopra, i mercati restano 40** e cresce la size. Mercati raggiungibili: **53/111 a
   $650** → 100 a $6.000 → **111/111 a $15.000**. Montepremi dei 40 tenuti: **$1.202/g → $4.608/g a
   $15.000, e lì SATURA**.
   **④ ⚠ LE STIME OLTRE ~$3.000 NON SONO DIFENDIBILI**: il modello ancorato ai nostri $4,40/g (che
   poggiano su **4 giorni di presenza**) darebbe $193/g a $15.000, ma i wallet con $10–25k incassano
   **$73–112/g mediani**. Il modello **sovrastima di ~2×** e non so riconciliare i due. **Non traccio la
   retta.** Servono **~15 giorni di presenza piena**.


22. **⚑ I MERCATI SBILANCIATI NON RENDONO DI PIÙ, E PER NOI RENDONO MENO — 13 agosto 2026.**
   **① Il reward per dollaro NON dipende dal livello di prezzo — analitico, non stimato.** `S(v,s)`
   contiene solo la **distanza dal mid in centesimi**, non il prezzo; e una COPPIA costa **$1 per
   share-pair a qualunque `p`** (Q share di YES a `p` + Q di NO a `1−p` = Q dollari). Quindi $32,67
   comprano **32,7 share per lato** sia a mid 0,50 sia a 0,99, e **Q per dollaro è identico**.
   **② MA Q_min si ROMPE a 0,10 e 0,90, ed è documentato**: dentro `[0,10 · 0,90]` una gamba sola
   prende `max(Qb,Qa)/3`; **fuori, Q_min = min(Qb,Qa), cioè una gamba nuda matura ZERO.**
   **③ La ripartizione del capitale è il problema**: a mid 0,90 il **90% del capitale sta sulla gamba
   CARA** e il 10% su quella economica. Per noi che siamo **nudi il 100% delle volte** (§5-bis p.152)
   significa la quasi totalità del capitale su una gamba che, sopra 0,90, **non matura niente**.
   **④ ⚠ IL TASSO DI ERRORE DEL MERCATO A 90+ NON È MISURABILE dal campione che ho.** I sei wallet a
   basso residuo vincono **+56,6 punti** sopra il prezzo nella fascia 0–0,10: è la firma della
   **selezione**, non una proprietà del mercato. L'unica affermazione lecita: **0 perdite su 3.108
   redeem sopra 0,97**, cioè un limite superiore al tasso di errore di **~0,1%**.

   **⑤ La nostra esposizione**: su 15.055 osservazioni del mid, **96,5% sta dentro `[0,10 · 0,90]`** e
   **3,5% fuori** — e quel 3,5% è **tutto** nella zona che `end-of-scale` consente.
   **⚠ LA NOSTRA SOGLIA È PIÙ LARGA DELLA ROTTURA DEL VENUE**: vietiamo sotto **0,03** e sopra
   **0,97**, ma Q_min si rompe a **0,10** e **0,90**. Fra 0,90 e 0,97 siamo **autorizzati a quotare in
   una zona dove una gamba nuda matura zero**. Non è un difetto dimostrato — è un disallineamento
   misurato, e la decisione è dell'operatore.
   **Punti 3 e 5 (tasso di fill e costo d'uscita per gamba) NON misurati**: il 3,5% di osservazioni in
   quella zona è un campione troppo piccolo, e non si conclude su code sottili.
21. **⚑ LE «CANCELLAZIONI CONTINUE» NON SONO UN CICLO DI RIPREZZO — misurato il 13 agosto 2026,
   finestra AVVIA 12:29 → 18:50, ~6,4 h.**
   **L'ipotesi peggiore è FALSA e va detta per prima**: se gli ordini vivessero meno di 60 s non
   sarebbero mai campionati dal venue (che campiona **al minuto**). **Vita degli ordini, n = 995**:
   q10 **176 s** · **mediana 1.093 s (18,2 min)** · q90 5.014 s. **Sotto i 60 s: 1,0%.** Un ordine
   mediano viene campionato **~18 volte**. Nessun capitale sprecato in ordini mai visti.
   **Il conteggio, e perché il giornale sembra dire il contrario**: 4.874 eventi di cancellazione, ma
   **solo 979 portano un `orderId`, su 927 ordini distinti (1,06 eventi per ordine)**. I **3.898**
   restanti sono **senza `orderId`** e sono macchina di chiusura, non riprezzo.
   **Per sorgente: `auto-close-on-fill` 3.361 (69%), `auto-reprice-band-exit` 1.458 (30%).** Le
   cancellazioni continue sono **la gestione delle gambe nude**, non ordini che ciclano.
   **⚠ CHIUSO IL 13 AGOSTO SERA DA §5-bis p.155**: la riga di `band-exit` porta già `scoringMid`,
   `distanceC` e `bandRadiusC`, e la misura è stata fatta — **`band-exit` è una VALUTAZIONE di riprezzo,
   non un'uccisione**: dei 3.622 giudizi «fuori banda» su ordini ancora dentro la banda vera, **ZERO**
   hanno prodotto una cancellazione. Il legame col 27% al bordo cade insieme alla p.152 che lo aveva
   calcolato sulla banda sbagliata.


20. **⚑ I NOSTRI FILL ARRIVANO SUL MID FERMO, NON SULLE RAFFICHE — misurato il 13 agosto 2026.
   Chiude la domanda «il riprezzo è la leva?»: NO.**
   **Strumento**: `auto-reprice` porta `observed.scoringMid` a ogni valutazione, cioè una serie del mid a
   **5 secondi** (47 mercati, 15.887 campioni), **quindici volte più fitta di `mid-history`**.
   **Il movimento è A RAFFICHE, e la mediana non lo descrive** (14.981 finestre da 60 s): mediana
   **0,000 tick** · q90 **17** · q99 **72**. Il mid è **fermo il 65% del tempo**; il **10% di finestre
   più mosse contiene il 69,2% del movimento totale**. ⚠ **Questo corregge §5.2 p.19**: «0,25 tick/ora»
   era una mediana su una distribuzione la cui media è 5,27 tick/60 s — priva di significato.
   **I FILL (1.041 distinti, 607 con serie utilizzabile)**: nei 60 s precedenti il mid era **FERMO
   (≤0,5 tick) nell'82,4%** dei casi, mosso >1 tick solo nel **13,3%** — contro un tempo-base mosso del
   30,5%. **Rapporto 0,44×: i fill sono SOTTO-rappresentati nelle raffiche.** Ci riempie un taker che
   attraversa lo spread su mercato fermo, che è ciò che un maker vuole — non selezione avversa.
   **⚠ E NELLE RAFFICHE NESSUNA CADENZA BASTEREBBE**: al q90 il mid si sposta di **8,5 tick in 30 s**,
   più della larghezza della banda. Non si insegue riprezzando: si insegue solo cancellando.
   **Conseguenza: `minIntervalMs`, `confirmSamples` e `hysteresisTicks` NON sono la leva.**


19. **🟡 LA CADENZA ADATTATIVA È SOTTO-RISOLTA — sola misura, e il costo è piccolo.** agent40
   classifica **2.392 osservazioni su 2.402 (99,6%)** come «lenta» con escursione **0,00 tick/ora** ⇒
   polling a 10.000 ms invece di 1.000. **Causa parziale misurata**: `leggiFinestraTutti` su **15 min**
   vede `rangeMid = 0` sul **48,8%** dei mercati (12 campioni mediani, perché `mid-history` campiona a
   **75 s**); a **240 min** i fermi scendono al **13,8%** (180 campioni).
   **⚠ Il conto non torna del tutto**: la fonte a 15 min dice 48,8%, agent40 ne logga 99,6%. **Divario
   non spiegato.** ⚠ **Ma non è la leva**: vedi p.20 — nelle raffiche nessuna cadenza basterebbe, e
   fuori dalle raffiche il mid è fermo.
9. **🔴 LA SENTINELLA VEDE IL VUOTO, NON IL COLLASSO — buco aperto, misurato il 13 agosto 2026.**
   Il ramo ③ di `lib/maker/sentinella-vuoto.js` dice «`ordiniARiposo > 0` ⇒ il libro non è vuoto» e
   **azzera l'orologio**. Quindi un calo da **23 ordini a 2** — il **91%** — è invisibile: la
   sentinella è tarata sul **caso estremo**, non sulla derivata. Osservato alle 09:08 (lì la causa era
   il guardiano, quindi lo stato era corretto: FERMA ⇒ vuoto giusto). **Ma la lacuna resta per il caso
   in cui il bot è su AVVIA**, ed è proprio il collasso progressivo che nessuno vedrebbe.
   **Non implementato**: la cura è un secondo criterio (calo relativo su una finestra) accanto al
   conteggio assoluto, e va tarato su una misura di quanto oscilla normalmente il numero di ordini —
   misura che oggi non esiste. Non si aggiunge una soglia a occhio a un presidio.
10. **Il costo di `profondita-non-verificata` NON è misurabile dallo stato salvato.** L'esclusione vive
   in `lib/rewards/allocator.js:1104` (`reasonCode: 'profondita-non-verificata'`), che gira in un
   **processo figlio**; `data/realloc-ultimo-piano.json` persiste **solo `righe`**, cioè i vincitori, e
   **nessun file conserva i candidati scartati**. Zero occorrenze in 4 giorni di giornale perché quel
   giornale non è dove finiscono. **Per questo il numero «non è mai stato misurato»: non è che nessuno
   l'abbia guardato, è che nessuno lo scrive.** La cura è una riga — l'istogramma dei `reasonCode`
   scartati accanto a `righe` — e senza quella non si tocca agent34, perché non c'è evidenza di costo.
11. **I rossi noti della suite sono NOVE**, e l'INSIEME dei nomi ruota — il conteggio no:
   `leg-order` e i due in `lib/venues/__tests__/` (test JS su moduli TypeScript: `node` non li avvia
   nemmeno) · `dipendenze-collegate` (falso positivo su un ternario andato a capo) ·
   `scaduto-senza-rinnovo` (fixture il cui ordine viene riprezzato al primo giro) · `scadenza-ereditata`
   · `categoria-mercato`, `end-of-scale-cycle`, **`tetto-orizzonte`** (**dipendono dai dati vivi**).
   **⚠ Aggiornato il 13 agosto 2026 sera: `velocita-mercato` è tornato VERDE e `tetto-orizzonte` è
   diventato rosso** — `tetto-orizzonte.test.js:142` legge `data/liquidity-rewards.json` e fallisce con
   «0 righe ora valutabili» perché il board vivo non ha più righe di coda lunga. Totale invariato a 9.
   **Chi confronta la baseline confronti i NOMI** (§5-bis p.134): qui i nomi cambiano da soli quando
   cambia il board, e un membro nuovo di questa famiglia non è una regressione — ma va verificato che
   il test rosso non tocchi il codice modificato prima di dirlo.

### 5.3 · Trappole operative — da rileggere prima di lavorare

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

## 5-bis · REGISTRO DELLE VOCI CHIUSE

**A cosa serve.** Le decisioni vive stanno in §4; qui resta la **mappa**, perché un riferimento come
«§5 punto 72» sparso nei commenti del codice deve restare risolvibile, e perché sapere *che* un
problema è già stato incontrato vale più del racconto di come. Il dettaglio integrale è in `git log`
e nei commit citati nei sorgenti.

**153 · IL GRADINO 6 NON ESISTEVA: `impostaBot` NON ERA IMPORTATO.**
`agents/agent41-realloc-scheduler.js:1766` chiamava `impostaBot({enabled:false, …})`, ma la
destrutturazione da `lib/maker/bot-enabled` (riga 271) si fermava a `registraMercatoAperto`. Il `try`
che avvolge `eseguiGradino` catturava il `ReferenceError` e lo restituiva come esito ordinario —
`azione fallita: impostaBot is not defined` — quindi la scala di sblocco arrivava in fondo,
**dichiarava di aver fermato il bot, e il bot restava su AVVIA**. **Sesta occorrenza della classe «dep
non cablata» di §5.3**, e la più insidiosa: `bot-enabled.test.js` provava che la funzione funziona, i
test su agent41 provavano i gradini 1-5 (tutti cablati), e nessuno provava il **filo**.
**Falliva CHIUSO** — nessun rischio di capitale, il bot semplicemente non si fermava.
**Misurato**: gradino 6 raggiunto **2 volte** in **11h20m** (il modulo esiste nel giornale solo dal
13/08 07:39:06Z, prima non c'è nulla): 08:59:06Z, **falso positivo** del difetto `ultimoCicloOk` di
p.135 (capitale al lavoro 82,7%, 28 ordini vivi), e 18:52:31Z, **vero** (23,8%, 1 ordine vivo).
Sul codice post-restart-78: **1 scatto in 6h46m, corretto.**
**Difetto minore, stesso commit**: il gradino 5 interpolava `pr.mercati` (l'array delle VOCI) invece
di `pr.marketIds`, e logava `[object Object]` sessanta volte — mentre il ciclo normale usava già
`marketIds.length`. Estratto in `messaggioFeedRiseminato`, puro, con l'assenza che **non diventa 0**.
Test: `lib/maker/gradino-sei-cablato.test.js`, 25 asserzioni. Difende la **proprietà** («nessuna
funzione di `bot-enabled` è chiamata senza essere importata»), non la stringa; esegue il gradino 6
**davvero** contro una spia installata prima del `require`; e **rilegge `data/maker-bot-enabled.json`
prima e dopo**, fallendo se è cambiato di un byte (§5 punto 1). Verificato che **fallisce sul codice
vecchio** — l'unica prova che un test serva a qualcosa.

**158 · LA MANOPOLA DELLA POSIZIONE, INSTALLATA E SPENTA.** Vedi il banner.
`lib/maker/distanza-obiettivo.js` (puro) + un ingresso opzionale in `planBehindBest`, applicato per
ULTIMO e solo verso l'esterno. **39 asserzioni** in `distanza-obiettivo.test.js`, e difendono le due
proprietà che contano — dentro banda **sempre**, mai davanti a nessuno — su tutti i valori provati
(0,1 · 0,25 · 0,444 · 0,6 · 0,9 · 0,95 · 5 · 100), non su quello di default.
**⚠ IL COSTO, MISURATO PRIMA DI INSTALLARLA** (`data/ricerca/manopola-distanza.json`, board vivo,
37.410 finestre da 60 s su 89 mercati): a 1,5× la distanza il reward modellato fa **−19%**, a 2× **−38%**,
a 2,5× **−57%**. E il **tasso di fill non si muove**: 4,60 → 4,40 → 4,36 → **4,13 al giorno**, cioè
0,47 fill evitati al giorno per **$0,005** di costo d'uscita risparmiato. **Il movimento del mid è a
raffiche molto più grandi della banda** (§5.2 p.20), quindi allontanarsi di uno o due centesimi non
sposta la probabilità di essere raggiunti. **Lo scambio è sfavorevole di due ordini di grandezza**, ed
è scritto qui perché l'operatore lo sappia mentre gira la manopola, non dopo.

**157 · IL RIFERIMENTO DEL GUARDIANO: DRAWDOWN DA MASSIMO MOBILE.** Vedi il banner. Chiude §5.2 p.14.
`lib/maker/guardian-riferimento.js` (puro) + cablaggio in `agent43-guardian`. **Il file resta uno solo**
(`data/guardian-baseline.json`) e continua a portare `baselineUsd`: il codice vecchio, non ancora
riavviato, legge il valore giusto invece di rompersi. Il record v1 si **MIGRA adottando** il valore che
c'era e lasciando che il massimo lo alzi — non si ricrea da zero, perché il giorno in cui il totale
corrente fosse più BASSO del riferimento vecchio ricreare cancellerebbe un drawdown in corso.
**⚠ La guardia sul capitale illeggibile è stata spostata PRIMA del riferimento**: un massimo mobile
aggiornato su una lettura fallita resterebbe sbagliato per sempre.
**28 asserzioni** in `guardian-riferimento.test.js`, fra cui le quattro che decidono: un deposito non è
un guadagno, un prelievo non è una perdita, un calo delle posizioni resta una perdita, un fill non è un
movimento di cassa.

**156 · IL TETTO PER MERCATO PASSA A $61,25, E SMETTE DI DERIVARE DA `f_min`.**
Vedi il banner per i numeri. Qui la forma. `lib/rewards/concentration.js`: `SCAGLIONE_FINANZIABILE = 50`
⇒ `TETTO_BASE_USD = pavimentoPremiante(50) = $61,25`, e `F_MIN_OBIETTIVO` diventa **derivato** (`0,32`).
**L'identità regge nei due versi** — `tetto = minSize × costo / f_min` — quindi i consumatori che
leggevano `F_MIN_OBIETTIVO` non si rompono. `fin` è stato spostato in cima al file: `TETTO_BASE_USD`
chiama `pavimentoPremiante`, che lo usa, e un `const` dichiarato dopo lo lasciava nella zona morta.
**Le derivate si muovono da sole** e nessuno le ricopia: tetto per ordine **$21,34 → $35,63**, tetto
assoluto di chiusura **$65,97 → $123,75**, finestra di mid **[0,36·0,64] → [0,43·0,57]**, mercati
sostenibili **19 → 10**, soglia di carico **$1.306 → $2.450**.
**⚠ `MAKER_LIVE_MIN_CAP_USD` NON ESISTE PIÙ**, verificato in `ecosystem.config.js` e in
`/proc/<pid>/environ` di agent40 e agent41: il vincolo a $30 descritto in `safety-risk-limits.json` se
n'è andato con `agent35-maker` il 9 agosto. Se ci fosse ancora, una gamba da $30,63 sarebbe stata
rifiutata e il bot avrebbe smesso di piazzare — è il primo controllo che è stato fatto.
**⚠ `maxOpenNotionalUsd = $600` NON limita quanti mercati si quotano**: conta i fill **riconciliati**
(`lib/safety/fills.js`), non gli ordini a riposo. Oggi 22 posizioni per $139.
**Test**: `lib/rewards/tetto-derivato-dallo-scaglione.test.js`, 25 asserzioni — fissa il tetto, le
derivate, il fatto che `f_min < 1` per costruzione, e che **nessun modulo cabli il valore** (stessa
forma di `banda-premiante.test.js`: filtra commenti e letterali di stringa).
**8 test rimessi in scala, non ammorbiditi**: le loro fixture erano tarate sul tetto vecchio. Dove il
test riproduce un INCIDENTE storico (`piano-non-si-svuota`, il deadlock del 13 agosto) il numero di
allora è ora un **letterale dichiarato**, perché un fatto storico non può dipendere dal valore di oggi.

**155 · LA BANDA PREMIANTE ERA LARGA LA METÀ — `v = max_spread`, NON `max_spread/2`.**
Vedi il banner per la prova e per le tre conseguenze. Qui restano i numeri e la forma della correzione.
**La SSOT**: `lib/banda-premiante.js` — `raggioBandaCents` · `raggioBandaPrezzo` · `dentroBanda` ·
`punteggio`. **46 file** instradati su di lei; **nessuno** ricalcola più il raggio da sé. Era il reperto
**D1** (costante ricopiata invece che importata) applicato al parametro che decide se un ordine matura:
**60 punti** se lo calcolavano ciascuno per conto proprio, ed è per questo che **due letture opposte
hanno potuto convivere** — `lib/reward-score.ts` aveva già la lettura giusta mentre tutto il resto no.
**La misura del costo, e il bracket**: l'insieme di scelta fra i mercati finanziabili va da **28 a 51**
(41 sbloccati sul board intero). Il guadagno modellato sui migliori 19 sta fra **1,32×** (somma dei
montepremi, indipendente dal modello) e **3,35×** (col tetto di credibilità in uso), cioè **+$1,4 · +$10,3
al giorno** sul consuntivo misurato di $4,40/g. **⚠ Il livello eredita i 4 giorni di presenza su 30 di
§5-bis p.152; il rapporto no.** Il numero **mercati coperti non cambia** — è `capitale / tetto = 19` a
qualunque distanza dal mid, perché il capitale per mercato è in dollari e non conosce la banda: **il
collo è il capitale, mai la banda** (19 finanziabili contro 51 disponibili e `MAX_MERCATI` 40).
**Allontanarsi dal mid non compra mercati e costa punteggio**: il massimo è alla distanza minima e
**non è piatto** — da 1,0¢ a 0,5¢ è **+30,6%**, da 1,0¢ a 2,5¢ è **−67,4%**.
**Test**: `lib/banda-premiante.test.js`, 29 asserzioni. Ancora la definizione all'**esempio ufficiale del
venue** (l'unico riferimento numerico esterno verificabile senza credenziali) e difende la **proprietà**
«nessun modulo divide un maxSpread per due», filtrando commenti **e letterali di stringa** — o
un'etichetta di stampa basterebbe a farlo passare. **Verificato che fallisce sulla lettura vecchia.**
Ha trovato da solo **due bugie nell'interfaccia** (`EventTerminal.tsx` diceva «± max_spread / 2»).
**14 test sono stati rimessi in scala, non ammorbiditi**: le loro fixture sceglievano un `maxSpread` per
ottenere un RAGGIO, e sotto la definizione corretta lo stesso raggio si scrive con metà del numero. Le
asserzioni sono identiche. **Sesta occorrenza di «test che fotografa il codice»**: `tetto-per-ordine`
asseriva su `git diff --name-only HEAD` (§5.3) ed è diventato rosso perché il codice era CORRETTO —
sostituito con la proprietà vera.
**Strumento trovato e NON cablato**: `GET /rewards/user/markets` del CLOB restituisce `earnings` e
`earning_percentage` **per mercato**, cioè l'attribuzione che §4.12 dà per impossibile. Senza le
credenziali L2 torna `maker_address: 0x000…` e zeri. **Cablarlo passa dall'adapter, cioè dalla
superficie che sa piazzare**: è una decisione dell'operatore, non un dettaglio.

**154 · IL FILTRO DI PROFONDITÀ NON STA AFFAMANDO IL PIANO — sola misura, niente toccato.**
`data/ricerca/sintesi-profondita.md`. **q = 0,60 è `realistic-estimate.DEFAULTS.maxCredibleShare`, che
il modulo etichetta da sé come ASSUNZIONE**: misurato fu il punto di applicazione, non il valore.
La soglia **non dipende dal capitale**, per scelta: `escluso ⟺ minSize_venue > depth·q/(1−q)`.
**⚠ `q/(1−q)` è CRESCENTE: abbassare q STRINGE il filtro** — 0,60 è già il più permissivo dei cinque
valori richiesti. **Sui 46 mercati finanziabili ne esclude 5 e ne lascia 41 contro 16 minimi (2,6×): la
precondizione dichiarata dal modulo REGGE.** E **da q=0,50 a q=0,90 il numero non cambia, perché tutti
gli esclusi hanno `depth` ESATTAMENTE 0** ⇒ la manopola è **inerte**. **Dove sta il capitale**: 13
posizioni su 22 ($73,35) in mercati AMMESSI, **1 sola ($2,19)** in un mercato escluso dalla profondità.
**I residui nascono sui book SPESSI**, e su n=16 nessuna differenza sarebbe rilevabile comunque.
**⚠ NON misurabile**: fill e costo di uscita sui mercati ESCLUSI (non ci abbiamo mai quotato), e reward
per dollaro PER MERCATO (§4.12: il venue paga un bonifico aggregato).

### Le tre voci del 13 agosto 2026

**120 · IL DEADLOCK ARITMETICO CHE HA FERMATO IL BOT PER TRE ORE.** `unitUsd = round(budget/50)` = $12
contro un tetto per mercato di $32,67 ⇒ `floor(32,67/12) = 2` livelli ⇒ **ogni riga di ogni piano
allocata a $24,00**; il mini-ciclo chiedeva `pavimentoPremiante(20)` = **$24,50** ⇒ **114 rifiuti
consecutivi identici** dalle 02:04 alle 05:56, con $609,10 liquidi e zero ordini a riposo. Non un caso
isolato ma un **dente di sega**: bloccato anche a $900, $1.000, $1.200, cioè **peggiorava crescendo il
capitale**. Due correzioni: la griglia limitata anche dal tetto (8 livelli minimi ⇒ passo $4, massimo
$32) e il pavimento di una riga misurato sulla **riga** (`minSizeShares × costoCoppia`) invece che su un
mercato tipico col margine del 25% applicato **due volte** — il margine vive già in `mercatoAmmissibile`.
**Il ciclo da 6 ore piazzava quelle stesse righe da $24 senza problemi**: due corsie, due minimi, sullo
stesso piano. Misurato: **0 mercati / $0 ⇒ 6 mercati / $180 in un giro**, utilizzo 8,4% ⇒ 35,4%.
Effetto collaterale voluto: `f_min` reale da 0,82 a **0,61**, cioè meno residui bloccati.
*(La premessa del prompt — «il piano si svuota» — era un sintomo: il mini-ciclo **ricalcolava già** a
ogni giro e trovava 12-19 righe. Le righe c'erano; nessuna passava il pavimento.)*

**121 · LA SENTINELLA SUL VUOTO.** Zero ordini a riposo per più di **5 minuti** con KILL spento e AVVIA
acceso è un'**anomalia**: allarme una volta per episodio nel log e nel giornale (`op: sentinella-vuoto`)
con la **ripartizione del fermo in dollari**, e **ricostruzione del piano chiesta a ogni giro** finché
dura. Rilevazione ogni 120 s ⇒ scoperta in **≤ 7 minuti contro i 180**. Cinque minuti perché un libro
sano non è mai vuoto se non per i secondi fra una cancellazione e il suo rimpiazzo — dieci volte quella
finestra, e ben sotto una finestra GTD. **Non allenta niente**: la sua unica azione è far girare
`controlloCapitaleFermo` adesso invece che al prossimo cooldown. È una sola **lettura**, e la quota
60/40 conta gli `intent`: **non toglie un posto ai rinnovi**. Conteggio illeggibile ⇒ **non arma e non
disarma** (un allarme che grida al primo 429 smette di essere letto). Bot fermo o kill attivo ⇒ il vuoto
è lo stato **corretto** e l'orologio si azzera.

**122 · UNA POSIZIONE SENZA SCADENZA È UNA POSIZIONE CHE NESSUNO CHIUDERÀ.**
`market-catalog.recordDaRigaBoard` **non mappava `endDate`**: ogni mercato preso in carico da agent41
finiva nel catalogo di ripiego con `endDate: null`, quindi appena usciva dal board `scadenzaMercato`
rispondeva `null` e `chiusuraForzataPreScadenza` rispondeva `forza:false`. **La seconda metà della
copertura era scritta e non veniva nutrita** — misurato: **5 posizioni su 7**. Adesso il mapper copia la
data **già unificata** più `endDateFonte`, e `lib/maker/scadenza-recupero.js` aggiunge la **terza
fonte**: quando board e ripiego tacciono si chiede al **venue** e si scrive nel ripiego, da cui
`scadenzaMercato` — che resta **sincrona**, per non toccare ogni suo chiamante — la trova al ciclo dopo.
Al più 5 richieste per giro, solo per i mercati con capitale dentro, mai più dopo la prima riuscita, e
chi ha già fallito non si richiede prima di 30 minuti. **Una data non parsabile non viene MAI scritta**:
una scadenza indovinata è peggio di una mancante — la seconda lascia la posizione aperta, la prima la fa
vendere al momento sbagliato.

**123 · I RESIDUI SOTTO IL MINIMO — BUCO STRUTTURALE APERTO, non implementato.** Il banner in testa
e §5.2 p.1 portano il fatto e la tabella dei cinque residui ($26,30); qui resta il **perché nessuna
delle tre porte si apre**, che è la parte che si dimentica: ① il riposizionamento vuole un ordine
≥ `minSize` e la size non ci arriva; ② il completamento della coppia vuole comprare `manca`, che è
sotto `minSize`; ③ il registro cresce **solo** con nuovi fill sullo stesso mercato/lato, e 3 mercati su
4 sono fuori dalla allowlist del riprezzo ⇒ **la size non crescerà mai**. `BELOW_MIN_SIZE` è
bloccante ed è giusto: un ordine sotto il minimo immobilizza capitale per un premio che vale **zero**.
**Cosa li chiude, e in quanto tempo: NIENTE, e mai** — restano fino alla risoluzione, da cui solo
`redeemPositions` li riporta a pUSD. Il capitale non è perso: è **irraggiungibile**. La proposta (redeem
quando `pulizia-mercato-chiuso` rileva la risoluzione) è scritta e **non implementata perché è
capitale**. **Mitigazione già attiva**: §120 ha portato `f_min` da 0,82 a **0,61**, cioè riduce il
tasso a cui il buco si riempie — **non chiude il buco**. Vedi anche §5-bis p.128 (non si può impedire
che nascano: la cura costa più della malattia) e p.150/151 (la via d'uscita è il redeem, non l'ordine).

**138 · LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA.** Vedi il banner per la scala, le soglie e i
limiti. `lib/maker/urgenza-scoperto.js` (puro) + `concessioneTick`/`profitPct` in `exit-plan.planExit`
+ `urgenza` in `auto-close.decideClose`. **La misura che ha deciso le soglie**, e che vale la pena
tenere: 24 episodi di scopertura in 48 h su 19 mercati, **bimodali** — 7 chiusi (mediana 10,5 min,
q75 29,3) contro 17 aperti (mediana 126,5 min, max 553,7). **11 episodi oltre l'ora, 61,1 ore-scoperto
complessive, $99,32 di nozionale di picco; $137,80 scoperti nell'istante della misura.**
**Il difetto NON era «il bot ripete identico»** — la premessa da verificare — ed è stato verificato:
11 prezzi distinti su 17 mid distinti. Il difetto era che **la gerarchia ha un solo orologio**.
**Cinque test nuovi** in `scoperto-oltre-soglia.test.js` (38 asserzioni) più 23 nel selfcheck del
modulo; tre asserzioni preesistenti sono passate **dalla frase alla proprietà** perché fotografavano il
testo del messaggio, e una in `chiusura-rapida.test.js` fotografava una **riga del sorgente** di
auto-close — la stessa classe di difetto di §5.3, alla quarta occorrenza.

**152 · IL BORDO DELLA BANDA NON CONVIENE — ⚠ NUMERI CORRETTI DA §5-bis p.155.**
Misura in `data/ricerca/sintesi-posizione-banda.md`. **La formula è verificata sulla documentazione
ufficiale viva**: `S(v,s) = ((v−s)/v)²·b`, `Q_min` con **c = 3,0**, size in **share**, **10.080 campioni
per epoca** (campionamento al minuto ⇒ il tempo a libro conta), soglia minima **per mercato**, banda
**simmetrica**, pagamento giornaliero a mezzanotte UTC. Al bordo `s → v` ⇒ `S → 0`: il bordo estremo
**non matura quasi nulla, per costruzione**, e questo resta vero.
**⚠ MA QUESTA VOCE APPLICAVA `v = 2,25¢` SU MERCATI CON `max_spread = 4,5¢`**, cioè la semiampiezza
dimezzata — cita la definizione giusta e usa il numero sbagliato. Rifatto il conto su **42.834**
osservazioni reali (`scripts/ricerca/nostri-s-reali.js`): **S medio 0,4951, non 0,2981**; il «27% a
S = 0,0076» è in realtà **S ≈ 0,3082**; la leva ② vale **+13,5%**, non +53%. ⚠ Il campione è la
**valutazione di riprezzo**, non i minuti a libro: è un proxy, e va detto.
**Restano validi**: il costo di un fill è **$0,05/g** di spread contro **$0,91/g** di capitale
immobilizzato ($135 in gambe nude), cioè **18×** — l'ipotesi «andare al bordo» è sbagliata di segno; e la
leva ① **presenza 4/30→29/30, +$100/mese**, che resta la più grande.
**⚠ Incertezza**: il reward osservato poggia su **4 giorni di presenza** e il costo di uscita su **13
vendite**. Servono **~15 giorni** di bot acceso per stabilizzare il resto.


**151 · IL REDEEM È UNA VIEW, NON GESTIONE DEL RESIDUO — corregge §150.**
`data/ricerca/sintesi-redeem.md`. **5.087 redeem su 8 wallet.** ⚠ Confondente escluso prima di
misurare: `usdcSize/size` vale esattamente 0 o 1 e **gli eventi a 0 esistono**, quindi niente bias da
sopravvivenza. **4.781 vinte = 94,0%: SANNO.** Due modi opposti: **famiglia A** (carico 0,999, 52-96%
degli acquisti sopra 97¢, PnL +0,2/+0,6%) compra esiti **già decisi**; **famiglia B** (carico
0,45-0,46, 0% sopra 97¢, vinte 67-99%) ha **edge vero** (+15%).
**⚠ Il 94% è una proprietà della loro SELEZIONE, non del meccanismo**: i nostri residui nascono da fill
parziali di coppie neutrali, quindi redimendoli incasseremmo il **valore equo, non il 94%**.
**Resta valido per altra ragione**: il redeem **non ha size minima**. Per le 10 posizioni da $50,32 il
confronto è «redeem al valore equo, zero spread» contro **«capitale congelato»**.
**⚠ La famiglia A opera dove `end-of-scale` ci vieta di andare** — a 99,9¢ un errore cancella ~mille
operazioni riuscite, ed è il modo di fallire contro cui la regola esiste.

**150 · COSA FANNO GLI ALTRI DOPO UN FILL — sola ricerca.** `data/ricerca/sintesi-post-fill.md`.
**82 wallet, 138.894 trade, 35.520 episodi.** Vie d'uscita: mai chiusa 37,3% · vendita 34,4% ·
**redeem 18,4%** · merge 9,9%.
**⚠ SIAMO GIÀ MEGLIO SU TRE ASSI SU QUATTRO**: durata mediana **21,8 min** contro 121,5-489,3 ·
**merge 43%** contro 1-5% · costo di uscita **0,25 ¢/share** contro 1,24 dei top30.
**⚠ L'UNICO PUNTO IN CUI SIAMO PEGGIO SONO I RESIDUI (18,0% contro 8,3-13,4%), E LA CAUSA NON È LA
SIZE**: correlazione taglio-ordine ↔ quota-residui **−0,141**, e il nostro $10,50 è già nella fascia
migliore. La causa è la **via d'uscita**: chi ha meno residui esce via **redeem** (87-98%) o **merge**.
⇒ le posizioni murate sotto il minimo (§5-bis p.123) non hanno bisogno di un ordine più grande, hanno
bisogno del **redeem**, che non ha minimo.
**⚠ Limite: la nostra riga poggia su 61 episodi in 26 ore** contro migliaia degli altri; maker-vs-taker
non è misurabile (`activity` non porta il flag).

**149 · CHI INCASSA DAVVERO I REWARD — sola ricerca, 30 giorni on-chain.**
`data/ricerca/sintesi-incassatori.md`. **$3.974.198 in 30 giorni a 14.836 wallet**, 7 tx/giorno a
~2.700 destinatari. ⚠ Fonte: **Etherscan V2 multichain** (`api.polygonscan.com` v1 è dismesso), e la
query va **partizionata per blocchi giornalieri** o si scambia una pagina troncata per l'ultima.
**172 wallet (1,9%) prendono il 59,2%**, presenti 29 giorni su 30. **NOI: percentile 39,3**, $17,59,
presenti **4 giorni su 30**. **⚠ Il consuntivo del pannello è CORRETTO**: coincide a quattro decimali
**sfalsato di un giorno** (il pannello data al giorno maturato, la catena al giorno pagato).
**⚠ I TOP SONO DIREZIONALI, verificato prima di concluderlo**: solo **4 wallet su 50** superano il 5% di
mercati appaiati; $6,74 M in posizione contro $1,65 M di reward — i premi sono un sottoprodotto.
**⚠ I 21 del manuale NON sono i top**: il migliore è 67°. **L'unica differenza replicabile a $650 è la
PRESENZA** (4/30 contro 29/30): il taglio dei nostri ordini ($10,76 mediano) è già dentro il range dei
top ($5,67–$16,86).

**147 · L'ESENZIONE DAL TETTO PER ORDINE VALE SU TUTTI I PERCORSI CHE RIDUCONO.** Il ramo
`riposizionamento-scoperto` (`auto-close.js:1412`) era l'unico percorso di chiusura a NON dichiarare
`chiudePosizione: true`. Misurato: una **SELL di 52,6 share GIÀ POSSEDUTE** rifiutata, e **1.331
rifiuti `manual-order-cap`**. ⚠ **Il guard esisteva già ed è sul percorso**: il GATE 4 rifà
l'aritmetica con `provaChiusura` sullo snapshot del venue — SELL oltre il posseduto o BUY oltre `manca`
**non** vengono esentate — e il tetto di safety resta intatto. **I sette percorsi sono TUTTI in
riduzione**, difeso da un test anche per proprietà (`bulk-allocate` non la dichiara mai).

**148 · IL REGISTRO DEI RESIDUI HA FINALMENTE UN CONSUMATORE.** `lib/maker/ritenta-residui.js` (puro)
+ cablaggio in `agent40` dentro `closeTask`: i mercati con una voce `pronto: true` entrano
nell'insieme che il ciclo di chiusura visita già. **Non è un lasciapassare**: il registro dice SOLO che
la size ha ripreso il minimo del venue, e da lì in giù valgono banda, tetti, «mai primo», profondità.
**Cadenza `INTERVALLO_RITENTATIVO_MS = 10 min`**, backoff ×2 sui fallimenti **con lo stesso motivo**
(un motivo diverso azzera: è un libro che si muove, non un blocco), tetto **2 ore**, al più **3 residui
per giro** — è manutenzione, non la corsia principale.
**⚠ IL REGISTRO NON SI SCRIVE MAI DA QUI**: un tentativo fallito lascia la voce dov'è, e un test lo
verifica. L'unico scrittore resta `accumulo-residui`. Il contatore del backoff vive in memoria: un
riavvio lo azzera e si ritenta prima, che è la direzione innocua.
Ogni tentativo va nel giornale (`op: ritenta-residuo`, esiti `residuo-pronto-rivisitato` /
`residuo-ripiazzato` / `residuo-ancora-bloccato`), così l'osservatore lo vede.

**145 · LE DUE CONFERME DEVONO ESSERE DUE OSSERVAZIONI, NON DUE COPIE.** Il terzo scatto (11:24:15Z)
è avvenuto **con k=2 attivo**: le due letture erano lo stesso numero (−32,58335, $627,98) perché
`SALDO_CACHE_TTL_MS = 45_000` contro `GUARDIAN_POLL_MS = 30_000`. **La correzione**: `confermaScatto`
riceve `osservazione.saldoLetturaAt` (`now − etaMs`) e conta la conferma **solo se cambiato**; se
uguale o illeggibile il contatore **resta dov'è**. ⚠ **Scartato abbassare il TTL**: la cache è
condivisa con agent40 (~5 s), col trigger e con agent45. **Verifica su 7.249 letture: senza la
condizione la simulazione riproduce esattamente lo scatto vero, con la condizione ne restano ZERO.**
Script: `scripts/ricerca/verifica-letture-distinte.js`.

**146 · I RESIDUI BLOCCATI, MISURATI — sola diagnosi.** 16 posizioni a gamba singola per **$158,44**
dopo il cancel-all del guardiano; **10 sotto il minimo** per **$51,78**; costo di uscire a mercato
**$8,81**, sul `bestBid` VERO del lato posseduto e non sul mark di mezzo.
Script: `scripts/ricerca/diagnosi-residui-bloccati.js`.

**144 · L'OSSERVATORE MUTO (agent45).** Vedi §3. `lib/osservatore/campionamento.js` è puro e testato
(47 asserzioni); l'agente importa SOLO `saldo-cache` (eth_call senza signer), lo snapshot posizioni e
`guardian-perdite` (puro). **Ordini a riposo e nozionale a book sono RICOSTRUITI** e il campo lo
dichiara: leggerli dal venue richiede una chiamata autenticata che passa dall'adapter, cioè dalla
stessa superficie che sa piazzare, e quella proprietà vale più della freschezza del campo.
**`ordiniPerMercato` resta `null` per sempre** con la strumentazione di oggi: il giornale REDIGE
`requested.marketId` sulle righe di elenco. Stessa famiglia di §5.2 p.10.
⚠ Il suo primo test ha trovato un `Number(null) === 0` **nel codice nuovo** (`curPrice` assente che
diventava una posizione da $0): settima occorrenza, e di nuovo trovata da una prova e non dal
ragionamento.

**141 · IL GUARDIANO NON SCATTA PIÙ SULLA PRIMA LETTURA (k=2).** Vedi il banner.
`confermaScatto` in `lib/maker/guardian-perdite.js` (puro, stato esplicito) + il cablaggio in
`agents/agent43-guardian.js`. **Verifica retroattiva**: 7.213 letture su 5 giorni rigiocate con le
funzioni vere ⇒ **da 2 scatti a 0**, entrambi falsi positivi con evidenza indipendente.
Script: `scripts/ricerca/verifica-persistenza.js`.

**142 · LA SENTINELLA SUL COLLASSO DELLA COPERTURA (85%), SOLO OSSERVA.** Vedi il banner.
`lib/maker/sentinella-collasso.js` (puro) + cablaggio in `agent41` accanto alla sentinella sul vuoto.
Chiude §5.2 p.9. Non agisce: log e giornale soltanto.

**143 · LA GAMBA SORELLA SI ABBASSA DENTRO LA BANDA.** Vedi il banner. `lib/maker/auto-close.js`,
blocco del Livello 2: `prezzo = min(tetto, bordo alto della banda)`. Il commento che diceva «non si
può alzare, è algebra» resta vero e resta lì — la domanda nuova era l'opposta, e nessuno l'aveva posta.

**140 · LA SOGLIA SULLA DERIVATA È 85%, E IL DIVARIO FRA LE DUE POPOLAZIONI È VUOTO — sola misura.**
Serie A · ordini aperti: **osservazione DIRETTA** (`manual-list` con `requested.marketId` nullo ⇒
`response.count` è il totale vivo), 7.860 campioni su **4,1 giorni**, cadenza mediana **60,0 s**.
**La forma è il calo % dal MASSIMO delle ultime 10 min**, non la differenza fra campioni consecutivi:
la cadenza è irregolare e un crollo in due campioni verrebbe spezzato in due pezzi sotto soglia.
**Sensibilità (veri/falsi su 4,1 giorni)**: 30% ⇒ 5/183 · 50% ⇒ 5/20 · 70% ⇒ 5/2 · **80% ⇒ 5/0**.
**Si propone 85% perché il divario è VUOTO**: fisiologico massimo **75%**, patologico minimo **92,9%**,
e in mezzo non cade nessun episodio. ⚠ **5 soli eventi positivi**: campione piccolo.
**Copertura e PnL NON sono correlati**: 460 punti a 5 min, **Pearson −0,048**. Le perdite non maturano
perché il book è scoperto. **I due scatti hanno la stessa firma**: caduta in **un solo campione**, da
cancellazione esterna (9/08 9→0, 13/08 28→2). Script: `scripts/ricerca/{estrai-serie-copertura,analizza-collasso}.js`.

**139 · IL SECONDO SCATTO DEL GUARDIANO — 13 agosto 2026, 09:08:33Z.** Vedi il banner. −$36,15 /
−5,47%, oltre **entrambe** le soglie, 23 ordini cancellati su 12 mercati, bot su FERMA. Il primo
scatto fu il 9 agosto (§5-bis p.70). **Il latch è attivo e il riarmo è dell'operatore.**

### Le voci del 13 agosto 2026, sera

**124 · IL CAPITALE AL LAVORO DICEVA L'INTENZIONE.** Vedi il banner. La correzione vale anche per le
**passate**: `esito` è solo l'ultima, e senza sommare le precedenti si dichiarerebbe meno del fatto.

**125 · RIFIUTI RIPETUTI: RICONOSCERE E REAGIRE** (`lib/maker/sblocco-progressivo.js`, puro).
Scala, classi e famiglie sono nel banner di §5 p.124-127. **N = 5** viene dai dati: sul giornale 9-13
agosto la stessa coppia (mercato, gate) si è ripetuta fino a **3.309 volte di fila**, quindi qualunque
soglia sarebbe scattata; a decidere è l'altro lato — un ordine si riprezza ogni ~60 s, quindi 5
ripetizioni identiche sono ~5 minuti in cui il libro si è mosso e la risposta non è cambiata. Sotto
(2-3) si prenderebbero i rimbalzi di un book che oscilla. Azzeramento su un **successo** o dopo
**15 minuti** di silenzio. **37 famiglie** classificate in `rischio` / `stato-bot` / `transitorio`;
una famiglia **sconosciuta vale rischio**.


**126 · COERENZA FRA I MODULI** (`lib/maker/coerenza-soglie.js`, puro). La classe di difetto: chi
propone non conosce le soglie di chi riceve, e ogni modulo preso da solo risponde correttamente alla
propria domanda. Due divergenze misurate: ① griglia $24,00 contro pavimento $24,50 ⇒ **114 rifiuti
identici, 3 ore di capitale fermo**; ② tetto per **mercato** $32,67 contro tetto per **ordine** $21,34
sulla gamba cara ⇒ **243 mercati su 321 (76%)** sfonderebbero, **631 `manual-order-cap` in 3 giorni**.
L'aritmetica di ②: `capitale ≤ tettoOrdine × costoCoppia / max(p_yes, p_no)`. Il capitale **può solo
scendere** (`Math.min`), quindi nessun tetto viene alzato. Il modulo **non importa nessuna costante**:
le soglie gliele passa chi le possiede, o nascerebbe la settima copia del tetto.


**127 · SCALA DI SBLOCCO E AUTODIAGNOSI.** Gradini e soglie nel banner. Le scelte: **5 minuti** per
gradino (il tempo in cui la sentinella vede un vuoto, più di due cadenze del trigger); **50%** di
capitale al lavoro come soglia di guasto — non il 95% dell'obiettivo, perché l'obiettivo è una tensione
e la soglia è un sintomo — perché sul giornale delle 48 h precedenti il regime bloccato stava a 8-40% e
quello sano a 44-63%; **15 minuti** sotto soglia perché un singolo giro sotto il 50% è normale dopo un
ribilanciamento. **L'ultimo gradino non è un'azione: è FERMA.**
**⚠ VERIFICA STORICA, e il risultato non è quello che si spererebbe.** Sui 102 mini-cicli del 10-13
agosto ci sono **4 finestre di blocco per 610 minuti**; **tre su quattro hanno la stessa causa — il
deadlock aritmetico — e per quelle la scala NON avrebbe sbloccato niente**: il bot sarebbe arrivato a
**FERMA in ~30 minuti**. Il guadagno è **da 286 minuti di finto lavoro a 30 minuti e un allarme grave**,
non a un bot che riparte. A sbloccare quelle tre è stata la griglia (§120). Capitale fermo: ~**6.190 $·ora**.


**128 · RESIDUI SOTTO SOGLIA: NON SI PUÒ IMPEDIRE CHE NASCANO — non implementato, con i numeri.**
**(a) Il venue non offre un vincolo di esecuzione utile, e la prova è nei tipi dell'SDK.**
`createAndPostOrder<T extends OrderType.GTC | OrderType.GTD>` — un ordine **a riposo può essere solo
GTC o GTD**, il sistema di tipi vieta l'alternativa. `FOK`/`FAK` esistono ma **solo** su
`createAndPostMarketOrder<T extends OrderType.FOK | OrderType.FAK>`, cioè su ordini **market**: eseguono
subito e **non riposano mai**, quindi maturano **zero reward** — che è l'intero ricavo di questo bot — e
attraversano lo spread. Nessun parametro di quantità minima eseguibile esiste (`minFill`, `allOrNone`,
`minExecutable`: **zero occorrenze** nei tipi). ⇒ **(a) è un no definitivo.**
**(b) Nessuna alternativa lato bot funziona, e la prima è aritmetica.** Il residuo scoperto dopo un
fill di frazione `f` vale `Q·f` share ed è copribile solo se `Q·f ≥ minSize`: essendo **continuo in
`f`**, per qualunque size esiste sempre un `f` che lascia un residuo sotto soglia. *Dimensionare gli
ordini perché il residuo resti sopra soglia è impossibile, non costoso.* *Spezzare in blocchi da
minimo-venue* non aiuta: un ordine da 20 share può essere riempito per 7. *Completare subito il fill* è
ciò che il bot **già fa** (Livelli 1-2, chiusura rapida, riposizionamento) e fallisce esattamente
quando `manca < minSize`, che è il caso in questione.
**(c) L'unica leva è `f_min`, e va nella direzione OPPOSTA a quella che sembra.** Il residuo si incastra
quando `f < f_min = minSize × costoCoppia / capitale`: quindi un tetto **più alto** abbassa `f_min` e
**restringe** la finestra che incastra. La correzione della griglia (§120) ha già portato le righe da
$24 a $32, cioè `f_min` da **0,817 a 0,600** — il tetto è già al massimo che il tetto per ordine e il
pavimento premiante consentono. Andare nell'altro verso costa: a `f_min = 1,00` il tetto scenderebbe a
$19,60 e la size per lato da **$16,34 a $9,80 (−40%)** su ogni mercato, per **13 eventi di residuo in
3 giorni** e **$35,03** oggi murati (5,3% del portafoglio). Una perdita anche solo del 20% sul
realistico (~$51/g) costa **più dell'intero capitale murato in tre giorni e mezzo**, e quel capitale non
è perso — è illiquido fino alla risoluzione. ⇒ **NON implementato: la cura costa più della malattia.**
**I cinque residui già esistenti restano una questione aperta** (§123): niente li chiude, `redeemPosition`
continua a non avere chiamanti, e la proposta del redeem dopo la risoluzione resta da decidere.

**129 · IL FILTRO ORIZZONTE COSTA 5,4× E NON PROTEGGE DA CIÒ CHE DICHIARA — misurato, NON implementato.**
Sola misura: `scripts/ricerca/orizzonte-{popolazione,sensibilita,brevi-rischio,maturazione}.js`, referto
in `data/ricerca/sintesi-orizzonte.md`. **`MIN_HORIZON_DAYS` resta 0,75** — `orizzonte-sensibilita.js`
sostituisce `horizonVerdict` **in memoria nel proprio processo figlio**, prima che `allocator.js:78` lo
destrutturi; il resto della catena è il codice di produzione.
**(a) IL COSTO, sulla stessa fotografia del board (20:17:13, $650, tetto $32,67).** Pavimento **0,75 g ⇒
3 mercati, $96 al lavoro, $554 fermi, $64,10/g**; pavimento **0,50 g ⇒ 21 mercati, $648 al lavoro,
$347,68/g**. Il gradino è **tutto fra 12 h e 18 h** (63 mercati); 0,25 / 0,40 / 0,50 danno il **piano
identico**, cioè il pianoro di insensibilità oggi è **6–12 h** e 18 h sta sull'altro lato. **Il rapporto
5,4× regge al taglio prudente delle quote a 15% (5,5×: $31,75 → $173,51/g)** — è l'unico numero della
misura che non dipende dal credere alle quote alte. Il livello no: **metà del lordo viene da 3 righe con
quota modellata 45–59%** su book sottili.
**(b) L'ORIGINE DELLA SOGLIA è documentata e derivata** (commit `123d812`, intestazione di `horizon.js`):
mediana **22,7 h** sugli ingressi premianti dei 21 maker contro 2,2 h sui non premianti, e 18 h scelte
perché **fra 12,4 h e 19,6 h il campione premiante era VUOTO**. Tre limiti dichiarati: il file stesso la
chiama «**un'assunzione**»; è tarata su **cosa fanno i vincitori**, non su cosa ci costa; e il commit
scriveva «**EFFETTO MISURATO: zero, oggi**» — oggi la stessa soglia toglie il **76%** del board, e il
vuoto 12,4–19,6 h su cui poggiava l'argomento **non esiste più**.
**(c) IL RISCHIO VERO STA A 6 ORE, NON A 18.** 21 maker, 120 coppie ingresso→ritiro premianti: uscite
**dopo** la risoluzione **35,1% sotto 6 h** (13/37), **0% fra 6 e 12 h** (0/36), **0% fra 12 e 18 h**
(0/15), **0% fra 18 e 48 h** (0/32). Regola del tre: 0/15 ammette fino a ~18%.
**(d) IL FILTRO AGISCE ALL'INGRESSO, IL RISCHIO ARRIVA DALL'INVECCHIAMENTO.** `nostro:` **22 gambe su 22
mercati, 22 NUDE, zero coppie complete**; delle 17 con scadenza leggibile **17 sono sotto le 18 h**
(tutte a 15,51 h). `modalita-chiusura`: 18 coppie su 23 con la sorella **mai piazzata**, età mediana
**9,5 h**. Residui: 25, **21 sotto il minimo del venue**, $145,07 murati, **18 dei 25 mercati sotto le
18 h e ZERO sopra**. Stiamo già correndo per intero il rischio da cui il filtro dovrebbe proteggere.
**(e) LA MATURAZIONE NON È IL VINCOLO.** Il venue campiona **1.440 volte al giorno** (uno al minuto —
già citato in `auto-reprice-config.js`): 6 h = 360 campioni = 25% di una giornata. Alla quota mediana
del piano (~14%) **il costo del giro rientra in meno di un'ora**.
**(f) L'ORIZZONTE VALE PIÙ DEL TETTO, E VANNO MOSSI UNO ALLA VOLTA.** Stessa fotografia: tetto $32,67→$245
a pavimento 0,75 fa **+5%** ($64,10 → $67,55: riempie il capitale e non muove il lordo, perché con 3
mercati il capitale in più va contro il tetto di credibilità); pavimento 0,75→0,50 a tetto fermo fa
**+442%**. E sotto il taglio prudente il tetto alto **si inverte** ($245 ⇒ $135,90/g contro $173,51/g a
$32,67), perché concentra su 9 righe con quote 24–60%. ⇒ **l'orizzonte per primo, il tetto non insieme.**
**(g) ⚠ IL COSTO VARIA DI ORA IN ORA.** Sulle 33 fotografie del 13 agosto i mercati corti vanno da **2
(15:16)** a **88 (18:18)**: un piano calcolato alle 16:00 e uno alle 20:00 vedono due board diversi, e
qualunque misura su una fotografia sola va marcata con l'ora. Deriva fra due giri identici: **~3%**.
**NON MISURATO:** il nostro tasso di fill per orizzonte (servirebbe lo stream del giornale maker da
340 MB con il join tokenId→conditionId). I nostri numeri ereditano i **4 giorni di presenza su 30**.

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

### Registro completo delle voci 1-119

| # | voce |
|---|---|
| 1 | Il bot non è mai stato avviato —  alle 12:07:55 UTC dell'8 agosto 2026 |
| 2 | La copertura dichiarata di FERMA non corrisponde al runtime di agent35 —  il 9 agosto 2026 rimuovendo il processo (§5 punto 63) |
| 3 | `REALLOC_SCHEDULER_DRY_RUN=1` resta nell'ambiente del processo agent41 — PER DECISIONE DELL'OPERATORE (8 agosto 2026), e un riavvio non può toglierla |
| 4 | L'header di `lib/maker/strategia-merge.js` è invecchiato |
| 5 | Arming disarmato da un kill ormai revocato —  il 9 agosto 2026: l'arming non esiste più |
| 6 | `data/maker-bot-enabled.json` e `data/cancellazioni-di-emergenza.json` non sono coperti da `.gitignore` |
| 7 | Il codice della sera del 7 agosto non è attivo —  alle 23:57 UTC del 7 agosto 2026 |
| 8 | `pgrep -f <nome-processo>` non è affidabile in questa sessione |
| 9 | Il codice dell'8 agosto non è nei processi —  alle 07:22 UTC dell'8 agosto 2026 |
| 10 | L'obiettivo non sente il tetto di credibilità —  l'8 agosto 2026, sera |
| 11 | Il confronto non ha ancora un dato —  l'8 agosto 2026, sera |
| 12 | I cinque test rossi: diagnosi fatta, correzione da decidere |
| 13 | Il caso degenere della concorrenza misurata ZERO —  l'8 agosto 2026, sera |
| 14 | Il lavoro sull'allocatore NON richiede riavvii, e vale la pena saperlo una volta per tutte |
| 15 | La rinomina non è ancora in pm2 —  alle 09:15:41 UTC dell'8 agosto 2026 |
| 16 | `agent44-audit-scoperta` esiste, gira alle 03:07 UTC, e la sua coda va guardata |
| 17 | Il trigger a capitale fermo non è nel processo —  alle ~11:24 UTC dell'8 agosto 2026 |
| 18 | La correzione del consumo di agent40 è in `main` ma non nel processo —  alle 12:07:06 UTC dell'8 agosto 2026 |
| 19 | IL PRIMO AVVIO NON HA UN INNESCO, e nessuno dei due percorsi lo copre |
| 20 | L'hook di piazzamento blocca anche il ciclo di agent41 lanciato a mano — ed è — , ma va saputo prima |
| 21 | Il trigger a $50 non ha MAI funzionato —  in `main`, ASPETTA IL RIAVVIO DI agent41 |
| 22 | Tre cose che il fix ha scoperto — le prime due CHIUSE l'8 agosto sera, la terza no |
| 23 | Il tetto di orizzonte non basta: l'universo eleggibile è zero —  l'8 agosto 2026 sera, ASPETTA IL RIAVVIO DI agent24 |
| 24 | IL 10 AGOSTO ALLE 01:01:33Z IL RESET CANCELLA TUTTO, se il board non è aggiornato per allora |
| 25 | La misura che ha fatto scattare tutto, tenuta come riferimento |
| 26 | DUE POSIZIONI APERTE SENZA VIA D'USCITA —  alle 16:49:18Z dell'8 agosto 2026 |
| 27 | I Livelli 1 e 2 non sono mai stati raggiunti —  alle 16:49:18Z dell'8 agosto 2026 |
| 28 | IL RIAVVIO DI agent40 ARMA UN COMPORTAMENTO NUOVO SU CAPITALE REALE — ESEGUITO alle 16:49:18Z dell'8 agosto 2026 |
| 29 | IL LIVELLO 1 (TAKER) NON PUÒ ESEGUIRE, ed è una protezione che NON è stata toccata |
| 30 | Verifica del gate fatta per test unitario, non sui dati vivi — e per una ragione buona |
| 31 | I DUE MERCATI CON POSIZIONE APERTA SONO TORNATI NELLA ALLOWLIST — 17:05:30Z dell'8 agosto 2026, su richiesta esplicita dell'operatore |
| 32 | SCHWARTZEL NON COMPLETA LA COPPIA: `closeTask` NON INIETTA `cancelOrder` —  in `main` l'8 agosto 2026 sera, ASPETTA IL RIAVVIO DI agent40 |
| 33 | La stessa guardia, un ramo più in là: `null` non è una cancellazione riuscita |
| 34 | TRE RIAVVII PENDENTI — ESEGUITI DALL'OPERATORE alle 18:30:52 / 18:31:02 / 18:31:16 UTC dell'8 agosto 2026 |
| 35 | Il 75,9% e non il 90%: il target non si raggiunge sempre, ed è il punto |
| 36 | `REALLOC_PIANO_LEGGERO_ORE` è il primo parametro che governa quanta memoria consuma un figlio |
| 37 | LA RICERCA SULLE CATEGORIE È FATTA, E RIBALTA LA LETTURA OVVIA |
| 38 | LE OTTO FASI DELL'8 AGOSTO SERA — IN `main`, E ASPETTANO QUATTRO RIAVVII |
| 39 | QUATTRO RIAVVII PENDENTI per le otto fasi |
| 40 | I ROSSI NOTI SONO SCESI DA QUATTRO A TRE |
| 41 | IL MINI-CICLO SCEGLIEVA MERCATI CHE POI NON POTEVA TOCCARE —  in `main` l'8 agosto 2026, ~21:30 UTC. ASPETTA IL RIAVVIO DI agent41, DA CONFERM |
| 42 | UNA GAMBA CANCELLATA BRUCIAVA LA SUA CHIAVE PER SEMPRE —  in `main` l'8 agosto 2026, ~22:20 UTC. ASPETTA IL RIAVVIO, DA CONFERMARE DA DIEGO IN |
| 43 | IL TETTO GIORNALIERO DI APERTURE È STATO RIMOSSO — 9 agosto 2026, ~02:40 UTC. ASPETTA IL RIAVVIO DI agent41 E DEL DASHBOARD, DA CONFERMARE DA DIEGO IN |
| 44 | UN MERCATO CHE ESCE DAL BOARD PERDEVA LA GESTIONE —  in `main` il 9 agosto 2026, ~03:50 UTC. GLI 11 ORFANI SONO GIÀ SANATI E VERIFICATI SUI DA |
| 45 | IL MERGE ON-CHAIN È COLLEGATO AL FLUSSO — `CTF_RELAYER_ENABLED` RESTA `false`, IN ATTESA DI AUTORIZZAZIONE ESPLICITA DI DIEGO IN CHAT |
| 46 | IL PERIODO DEL BOARD ERA 22,5 MINUTI, NON 15 —  in `main` il 9 agosto 2026, ~04:40 UTC. ASPETTA IL RIAVVIO DI agent24 E agent41, DA CONFERMARE |
| 47 | IL RIPIEGO DELLE REGOLE COPRIVA UN PERCORSO SU DUE — ESTESO il 9 agosto 2026 |
| 48 | LO SPLIT NON VA COLLEGATO, E LA MISURA È NETTA — deciso il 9 agosto 2026, nessun codice scritto |
| 49 | `CTF_RELAYER_ENABLED = true` — ACCESO il 9 agosto 2026, ~04:30 UTC, su istruzione esplicita di Diego in chat. IN `main` E NEI PROCESSI |
| 51 | LA SEQUENZA COMPLETA DEL LATO SCOPERTO — in `main` il 9 agosto 2026, ~05:45 UTC. ASPETTA IL RIAVVIO DI agent40 |
| 52 | IL MERGE ON-CHAIN NON HA MAI FIRMATO: `deps.signerProvider` NON ERA CABLATO —  in `main` il 9 agosto 2026, ~07:05 UTC. ASPETTA IL RIAVVIO DI a |
| 53 | I TETTI DI CAPITALE ERANO FERMI AL CAPITALE DI TRE ORE PRIMA, E IL 90% ERA IRRAGGIUNGIBILE PER COSTRUZIONE —  in `main` il 9 agosto 2026, ~07: |
| 54 | LA REGOLA GENERALE DEL LATO SCOPERTO — decisa da Diego il 9 agosto 2026, in `main` alle ~08:05 UTC |
| 55 | IL TETTO DELLA CATENA DI SOSTITUZIONI MURAVA UNA GAMBA VIVA —  in `main` il 9 agosto 2026, ~08:35 UTC. ASPETTA IL RIAVVIO di agent40 e agent41 |
| 56 | IL LIVELLO 3 USCIVA IN SILENZIO —  il 9 agosto 2026, stesso commit |
| 57 | CINQUE MERCATI FINTI NEI DATI VIVI — rimossi il 9 agosto 2026 |
| 58 | 🔴 IL CAPITALE ERA CONTATO DUE VOLTE — BUG DI SICUREZZA OPERATIVA, non estetico. Corretto in `main` il 9 agosto 2026, ~10:00 UTC. ASPETTA IL RIAVVIO d |
| 59 | ⚠️ L'UNICA ECCEZIONE A «MAI PRIMI SUL LIBRO» — mirata, circoscritta, decisa da Diego il 9 agosto 2026. In `main` alle ~10:30 UTC. ASPETTA IL RIAVVIO d |
| 60 | «PRIMO ASSOLUTO» SI MISURA SUL LIBRO, NON SULLA BANDA —  il 9 agosto 2026, ~11:00 UTC. ASPETTA IL RIAVVIO di agent40 |
| 61 | IL BOT NON VEDEVA IL LIBRO DEI MERCATI IN CUI AVEVA DEI SOLDI —  il 9 agosto 2026, ~12:00 UTC. ASPETTA IL RIAVVIO di agent34 |
| 62 | VISTI MA INTOCCABILI — la TERZA volta della stessa lacuna, il 9 agosto 2026, ~12:20 UTC. ASPETTA IL RIAVVIO di agent40 e agent41 |
| 63 | 🧹 MAKER ARMING, agent35-maker E agent37-maker-watchdog SONO STATI RIMOSSI — 9 agosto 2026, ~14:00 UTC, su decisione esplicita di Diego. In `main`. DU |
| 64 | IL TETTO DI CREDIBILITÀ ERA UN'ATTENUAZIONE E ORA È ANCHE UN CANCELLO — in `main` il 9 agosto 2026, ~17:45 UTC. ASPETTA IL RIAVVIO di agent41, DA CONF |
| 65 | TETTO PER MERCATO FISSO A $130 E NESSUN LIMITE DI POSIZIONI — decisioni di Diego, in `main` il 9 agosto 2026, ~18:50 UTC. ASPETTA IL RIAVVIO di agent4 |
| 66 | LA RISPOSTA AL FILL: QUATTRO CORREZIONI, E IL CABLAGGIO CHE LE RENDE EFFETTIVE — 9 agosto 2026, ~20:15 UTC. agent40 RIAVVIATO su autorizzazione di Die |
| 67 | IL QUARTO PUNTO DEL TETTO: $25 PER ORDINE CONTRO $130 PER MERCATO —  e DEPLOYATO il 9 agosto 2026, ~21:04 UTC. TRE RIAVVII ESEGUITI su autoriz |
| 68 | LA GAMBA ORFANA VENIVA RINNOVATA ALL'INFINITO —  in `main` il 9 agosto 2026, ~22:10 UTC. ASPETTA IL RIAVVIO di agent40, DA CONFERMARE DA DIEGO |
| 69 | IL GATE live-min LEGGEVA LA LISTA STRETTA: L'UNIONE DEL PUNTO 62 NON ARRIVAVA AL PIAZZAMENTO —  in `main` il 9 agosto 2026, ~22:15 UTC. TRE PR |
| 70 | IL GUARDIANO DELLE PERDITE È SCATTATO — 9 agosto 2026, 21:46:38 UTC. PRIMO SCATTO REALE |
| 71 | IL REGISTRO DA 731 MB: LETTURA INCREMENTALE SU TUTTI I PUNTI NOTI — in `main` il 9 agosto 2026, ~23:00 UTC. agent40 (71) e agent41 (51) RIAVVIATI |
| 72 | UN FILL VALEVA UNA VOLTA PER RIPIAZZAMENTO —  in `main` il 9 agosto 2026, ~23:25 UTC. agent40 (72) e agent41 (52) RIAVVIATI |
| 73 | IL RIPREZZO È DIVENTATO ATOMICO NEL SENSO CHE CONTA: NON CANCELLA CIÒ CHE NON PUÒ RIPIAZZARE — in `main` l'11 agosto 2026, ~19:20 UTC. agent40 RIAVVIA |
| 74 | VERIFICA COMPLETA E RIAVVIO PULITO DELLA FLOTTA — 11 agosto 2026, 20:21-20:50 UTC, su autorizzazione esplicita di Diego. Nessuna modifica di codice: s |
| 75 | I DUE LAVORI DELL'11 AGOSTO SERA, MAI DOCUMENTATI FIN QUI |
| 76 | IL TETTO PER ORDINE NON RIGUARDA CHI CHIUDE, E UN TAKER NON MIRA AI PROPRI ORDINI — in `main` il 12 agosto 2026, ~09:00 UTC. agent40 e dashboard RIAVV |
| 77 | LA CHIUSURA RIPROVA, LA SORELLA CRESCE, E UN MERCATO MORTO NON RESTA IN SEI REGISTRI — in `main` il 12 agosto 2026, ~09:30 UTC. agent40 RIAVVIATO |
| 78 | IL PANNELLO NON DICHIARAVA I PROPRI ORDINI, E LA SELEZIONE ERA SCRITTA A MANO IN DUE PUNTI —  il 12 agosto 2026. ASPETTA IL RIAVVIO di agent40 |
| 79 | `clobRewards` ASSENTE NON È `clobRewards` A ZERO — 12 agosto 2026. NESSUN RIAVVIO NECESSARIO per la ricerca; il dashboard serve il gate, quindi il suo |
| 80 | `inCoda` E `priceAdjusted` ARRIVANO IN `execution-audit` E SUL PANNELLO — 12 agosto 2026. ASPETTA IL RIAVVIO del dashboard e di agent40 |
| 81 | IL LATCH DEL GUARDIANO SCADE, E NON SI FIDA PIÙ DI SE STESSO — 12 agosto 2026. ASPETTA IL RIAVVIO di agent43 |
| 82 | LA PULIZIA DEI REGISTRI NON DIPENDE PIÙ DA CHI ITERA COSA — 12 agosto 2026. ASPETTA IL RIAVVIO di agent40 |
| 83 | UN 429 SU `/positions` NON FERMA PIÙ IL BOT — 12 agosto 2026. ASPETTA IL RIAVVIO di agent40 |
| 84 | LA BASELINE DEI TEST È CAMBIATA: 7 ROSSI, NON PIÙ 8 |
| 85 | LA CHIUSURA FORZATA A 3 ORE ESISTEVA E NON POTEVA SCATTARE — 12 agosto 2026 |
| 86 | IL CONSUNTIVO REWARD SI RECUPERA A RITROSO — 12 agosto 2026 |
| 87 | IL REGISTRO DEI REWARD INCASSATI — 12 agosto 2026 |
| 88 | PERSISTENZA DOPO CRASH, PROVATA CON UN `kill -9` — 12 agosto 2026 |
| 89 | SOLI SUL LATO: AL BORDO ESTERNO DELLA BANDA — 12 agosto 2026 |
| 90 | LA QUOTABILITÀ È UN FILTRO A MONTE, E IL CAPITALE LIBERATO SI RIDISTRIBUISCE — 12 agosto 2026 |
| 91 | ⚠ LA SCANSIONE DEI REGISTRI AVEVA ROTTO UN'INVARIANTE, e un test l'ha preso |
| 92 | VOCE 1 · LA SOVRASTIMA DEL 465% È UN TASSO LETTO COME QUANTITÀ — sola diagnosi |
| 93 | VOCE 3 · LE DUE CADENZE ERANO GIÀ A TERRA: VERIFICATE E BLOCCATE |
| 94 | VOCE 4 · TRE CECITÀ DIVERSE SOTTO LO STESSO OROLOGIO |
| 95 | VOCE 5 · VERIFICA DI TENUTA DEI BLOCCHI A+B: TRE PUNTI REGGONO, IL QUARTO AVEVA UNA LACUNA |
| 96 | VOCE 6 · IL RESET DISTINGUE PER ORIGINE — MA UNA SORGENTE SU TRE HA IL NOME SBAGLIATO |
| 97 | VOCE 2 · RIAVVII AUTOMATICI ROBUSTI, E IL DASHBOARD CHE NON SI RIALZAVA |
| 98 | IL ROSSO CHE LA SUITE HA TROVATO, E CHE NON VENIVA DA OGGI |
| 99 | IL CARICATORE `.env` SUI TRE AGENT RESTANTI, MA RISTRETTO |
| 100 | OPZIONE A: LA STIMA DIVENTA UNA QUANTITÀ INTEGRATA |
| 101 | LA COSTANTE SBAGLIATA, E PERCHÉ CORREGGERLA DA SOLA SAREBBE STATO UN DANNO |
| 102 | UNA SOLA MISURA DI ORIZZONTE, E LO SCARTO A MONTE |
| 103 | IL FRENO DI PROVA, CHE PRIMA NON ESISTEVA |
| 104 | UNA SOLA VERITÀ SUL CAPITALE |
| 105 | PERCHÉ IL MINI-CICLO NON PIAZZA — DIAGNOSI, NON —  |
| 106 | IL LEDGER NETTATO, E `skipped` CHE NON SPARISCE PIÙ |
| 107 | IL TETTO DERIVATO |
| 108 | UNA SOLA FORMULA CAPITALE→SHARE |
| 109 | LA COERENZA A VALLE, E UNA MISURA CHE CORREGGE UNA STIMA DI OGGI |
| 110 | IL RAMO `skip` INGHIOTTIVA LA GERARCHIA, E LA DECISIONE USCIVA MUTA —  il 12 agosto 2026, ~19:00 UTC. agent40 RIAVVIATO |
| 111 | PERCHÉ L'UTILIZZO ERA AL 7,5% — E NON È IL TETTO DERIVATO. Sola diagnosi, nessun codice |
| 112 | OPZIONE B: IL TRONCAMENTO PROVATO RESTITUISCE L'ORA VERA — 12 agosto 2026, ~19:40 UTC. agent24 RIAVVIATO |
| 113 | LA «FINESTRA DI MID» NON È UN CANCELLO — sola diagnosi, nessuna correzione |
| 114 | I TETTI PER GIRO ALZATI, E IL TETTO ANTI-RUNAWAY CHE AFFAMAVA IL RINNOVO — 12 agosto 2026, ~21:40 UTC. Decisione dell'operatore: il capitale deve lavo |
| 115 | IL PIAZZAMENTO DELLA COPPIA È ATOMICO IN PRECONTROLLO — 12 agosto 2026, ~21:55 UTC |
| 116 | LA QUOTA 60/40 SULLA FINESTRA — implementata, ma la premessa era sbagliata (12 agosto 2026) |
| 117 | `REWARD_MAX_CLOB_MARKETS` È GIÀ AL MASSIMO: 150 — sola diagnosi, nessuna modifica |
| 118 | IL CAPITALE AL LAVORO: UN NUMERO, UN OBIETTIVO, E IL FERMO RIPARTITO IN DOLLARI |
| 119 | L'ANELLO DEL FEED APERTO, E IL TURNOVER CHE NON SI CORREGGE DA LÌ — 13 agosto 2026, ~00:45 UTC |

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
- **SI SCRIVE GIÀ COMPATTO.** Questo file ha raggiunto **494k caratteri** ed è stato compattato a
  ~86k il 13 agosto 2026: la causa era che ogni voce veniva scritta come un *racconto* invece che come
  una *regola*. La regola d'oro: **§4 dice cosa è vero adesso, §5 cosa è ancora aperto, §5-bis è la
  mappa.** Una voce chiusa scende a una riga nel registro, mantenendo il suo numero originale — i
  commenti nei sorgenti citano «§5 punto N» e quel riferimento deve restare risolvibile. La storia
  integrale non va copiata qui: sta in `git log` e nei commit citati nei sorgenti.
- **Il tetto è 150k caratteri.** Superarlo significa che il file non entra più nel contesto di una
  sessione, cioè che smette di fare il proprio mestiere. Se lo si supera, si compatta **nella stessa
  sessione** — non si rimanda.
- **§2 non si tocca** senza istruzione esplicita dell'utente in chat.
- Aggiorna la data di «ultima verifica» in cima quando rivedi §3/§4.
- Il file va **committato e pushato** insieme al lavoro che lo ha reso obsoleto, non dopo.

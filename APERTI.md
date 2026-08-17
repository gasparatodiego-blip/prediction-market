# Cosa resta aperto — aggiornato il 17 agosto 2026

Scritto perché una sessione nuova possa riprendere **senza rileggere tutto**. In ordine di quanto
costa se non si ripara. Lo stato del sistema al momento della chiusura è in fondo.

---

## 0 · 🔴 IL RIPREZZO CANCELLA E NON RIPIAZZA — 197 minuti di gamba singola il 16 agosto

**È il capofila, e l'ha trovato la misura del 17 agosto** (`data/ricerca/gambe-16-agosto.md`,
script `scripts/ricerca/cronologia-gambe-16-agosto.js`): **il 68,1 % dei minuti di gamba singola**
della giornata viene da qui — 160,8 min da `nozionale-mercato-oltre-tetto` e 36,2 da
`doppione-identico`, su 289,3 totali.

`replaceManualOrder` ha **cinque precontrolli prima di cancellare**, tutti con `oldCancelled:false`,
esattamente perché una cancellazione senza ripiazzo lascia la gamba scoperta
(`lib/maker/manual-order.js:1716-1806`). **I due gate aggiunti ieri sera non sono in quell'elenco**:
`doppione-identico` (`:1291`) e `nozionale-mercato-oltre-tetto` (`:1316`) vivono dentro
`placeManualOrder`, cioè **dopo** la cancellazione. Il riprezzo passa i cinque, **cancella**, poi il
sesto gate rifiuta, e la gamba è persa. Classe «protezione presente su un percorso e assente sul suo
gemello», già contata 5+ volte nel registro.

**⚠ E un secondo difetto dentro il primo, di segno**: il gate del nozionale somma `ordini a riposo +
questo ordine`, che è l'aritmetica di chi **apre**. Su un riprezzo l'ordine che si sta sostituendo
**è già dentro** gli ordini a riposo ⇒ contato due volte. Evidenza, giornale delle 12:14:42 su FL-27:
«$53.67 di ordini a riposo (2) e questo ne aggiungerebbe $11.42» — e $11,42 **era** l'ordine che
stava per essere ripiazzato. Il sottraendo esiste già (`:1311`) ma si applica solo al ramo della
gemella dentro `place`. **Terza occorrenza** della classe «regola nata per limitare l'APERTURA
applicata a un'azione che non apre» (§5-bis p.133, p.147, p.168).

**La cura**, e le due condizioni che il difetto insegna: ① **la stessa funzione, non una copia** —
precontrollare con un numero diverso da quello che poi rifiuta è peggio che non precontrollare
(è scritto nel commento del precontrollo esistente, `:1782`, ed è il reperto **D1**); ② il nozionale
a riposo deve **escludere l'ordine che si sta sostituendo**, o il tetto rifiuta un riprezzo che non
aggiunge un dollaro.

---

## 1 · 🟢 La copertura continua RIPIAZZA — fatta il 17 agosto 2026, da osservare dal vivo

**Costo**: uno slot con una gamba sola non matura niente e, se quella gamba si riempie, diventa
esposizione direzionale — che è il modo in cui oggi si è persa la giornata.

`lib/maker/copertura-gambe.js` decideva correttamente (`coperto` / `da-coprire` / `non-quotabile` /
`da-sostituire`, 13 asserzioni verdi) ed era cablato in `agent41.riconciliaCopertura`, ma quel
cablaggio **dichiarava e basta**.

⚠ **NON rimettere la chiamata a `controlloCapitaleFermo`**: l'ho fatto stamattina e ha prodotto
**799 ricostruzioni del piano consecutive**, agent41 da 9 a 14 riavvii, e un **quarto mercato**
aggiunto alla allowlist (quel trigger abilita ciò che il PIANO sceglie, e il piano non conosce i tre
slot). La lezione, che vale oltre questo caso: *un riconciliatore che agisce sull'anello che osserva
non chiude più l'anello, e la frequenza del ciclo diventa la frequenza dell'azione.*

**La strada giusta**, ed è quella presa: aprire le gambe mancanti sui mercati **già in gestione**,
senza ricostruire il piano — un piazzamento mirato che riusa il prezzo del motore.

**FATTO** (`a6b31bb`, `lib/maker/ripristino-gambe.js` puro + cablaggio in `riconciliaCopertura`).
Il numero che governa il disegno è **720**: il ciclo gira ogni 120 s, quindi senza raffreddamento un
mercato che rifiuta sempre verrebbe ritentato 720 volte al giorno — la forma esatta delle 799.
Il raffreddamento è una scala sui fallimenti **consecutivi** (subito · 5 · 10 · 20 · 30 min di tetto),
azzerata su `coperto` **osservato**. **Contenimento provato: 50 tentativi su 720 cicli, 14,4×.**
Le tre cose che non fa: non è una seconda strada verso il venue (piano salvato → `gambeDiUnaRiga` →
`piazzaCoppia`), **non ricostruisce il piano**, **non abilita niente**. E una che fa: scrive sempre a
verbale, anche quando non tenta.
⚠ **NON È IN SERVIZIO**: agent41 gira col codice di prima e va riavviato. Il bot è FERMO e
`riconciliaCopertura` è comunque a valle di `botAttivo()`.
⚠ **Non è mai stata esercitata su un mercato vero.** 28 asserzioni sullo SCATTO, ma il primo giro vivo
è la prova che conta.

**Com'era il 16 agosto, misurato**: `riconciliaCopertura` **è stata chiamata** a ogni ciclo (riga
2607, prima di `decidiTrigger`) e per progetto non piazzava — dichiarava e forzava il mini-ciclo, che
su **82 esecuzioni** ha risposto **49 volte `nessuna-azione`**. E scriveva con `annuncia`, cioè nei
log di pm2: **ZERO record nel giornale**, quindi non si può dire *quali* gambe avesse visto mancanti.
Quella lacuna è chiusa — ora si scrive sempre a verbale — e la lezione resta: **un presidio che non
lascia traccia non è verificabile**.
**⚠ E l'unico percorso che ripiazza davvero è stato saturato**: `rimpiazzo-gamba`
(`source: auto-close-on-fill`) ha fatto **133 `saltato-tetto-saturo`** e 21 `sotto-size-minima`
contro **3 `rimpiazzata`**. Il comportamento è corretto — non forzare il tetto è la regola — ma la
via di ritorno esisteva e per 133 volte su 157 non poteva percorrerla.

---

## 2 · 🟢 Sette test rossi — CHIUSI il 17 agosto 2026 (`3bc7fad`), più uno e più tre selfcheck

**Costo**: bassi in sé, ma sono la rete che protegge il resto. Ogni giorno che restano rossi, un
rosso vero si nasconde fra loro.

| test | perché è rosso | cosa farne |
|---|---|---|
| `mid-stantio.test.js` | asserisce «il difetto è 20 s» | **aggiornare a 120** (valore deciso, `6cc41b2`) |
| `cecita-distinta.test.js` | idem | **aggiornare a 120** |
| `riprezzo-atomico.test.js` | asserisce la **forma esatta** dell'import del tetto | riscrivere: verificare il **comportamento** (il tetto usato è quello di `concentration`), non la stringa del `require` |
| `tetto-per-ordine.test.js` | idem | idem |
| `coerenza-tetto-derivato.test.js` | idem | idem |
| `gestione-manuale-nel-flusso.test.js` | legge la stringa `REALLOC_SCHEDULER_DRY_RUN` dentro un **commento** che ho scritto io | far **filtrare i commenti** al test, come CLAUDE.md §5.3 prescrive già |
| `selezione-cablata.test.js` | «il vincolo è esattamente l'insieme scelto» | da diagnosticare |

Ho toccato la riga di import aggiungendo `MARKET_CAP_FIXED_USD`: i tre test sull'import si sono rotti
per quello. **Sono trappole, non test**: si romperanno a ogni refactor finché guardano la stringa.

**CHIUSI TUTTI E SETTE, senza ammorbidire nessuna asserzione.** I tre sull'import ora **provano** che
il valore arriva da `concentration`: si sostituisce quel modulo in `require.cache` con una sentinella
e si ricaricano i consumatori. `selezione-cablata` era verde da solo. **E il quinto aveva ragione il
TEST e torto il codice**: `agent41:1243` passava `MARKET_CAP_FIXED_USD` nudo invece di
`capPerMarketUsd(capitale)` nel calcolo dei netti degli sfidanti — corretto, può solo stringere.
**Più `modalita-chiusura`**, che non era in elenco (vedi CLAUDE.md §5.2 p.39), e **tre selfcheck**:
`maker-selfcheck` (fixture posizioni mancante ⇒ misurava lo stato vero della macchina),
`rewards-realistic-estimate` (banda vecchia `v = max_spread/2`), `maker-kill` (moriva di ENOENT su un
file spostato in `_archivio` — un test che non parte non è un test rosso, è un presidio spento).
**Suite: da 19 rossi a 12, zero nuovi.** Selfcheck: 11 su 12. Resta `maker-multimarket` (77 ok, 6
falliti), con una fixture inchiodata alla data di chiusura reale di un mercato — dipende dai dati vivi.

---

## 3 · Un percorso rigenera il BUY sulla stessa gamba — 🟢 **IDENTIFICATO il 17 agosto**

**Il percorso è `op: 'rimpiazzo-gamba'`, `source: 'auto-close-on-fill'`.** Nel giornale, con le
proprie parole: «*la gamba NO era stata eseguita: torna sul libro a 0.14 per 152,4 share, dentro lo
spazio rimasto sotto il tetto ($21.342 di $56)*» — e la gemella a 237,6 share, stessa forma.

**Non è un difetto: è il meccanismo che rimette la gamba sul libro dopo un fill**, ed è l'unico che
lo fa (vedi punto 1). Le due comparse di ieri sono **3 `rimpiazzata` su 157 tracce**; le altre 154
si sono fermate da sole al tetto o sotto la size minima. Quello che mancava non era un freno: era
**sapere chi fosse**, e ora si sa.

**⚠ Resta però vera la preoccupazione che ha aperto questo punto**, e va tenuta: un rimpiazzo sul
lato che già possediamo **ingrossa la gamba scoperta** se il fill arriva prima della sorella. Oggi
lo limitano il tetto per mercato e la size minima — cioè due cinture che hanno agito 154 volte su
157. **Da guardare al primo giro vivo con un fill vero**, non da correggere alla cieca.

---

## 4 · `stato.js` legge le cinture dal `.env`

**Costo**: una decisione sbagliata nel momento peggiore. In emergenza direbbe «sei fermo» mentre i
processi sono armati — verificato oggi: `.env` diceva `MAKER_PLACEMENT=` vuota mentre `/proc` diceva
`send`.

**Cura**: leggere `/proc/<pid>/environ` dei pid da `pm2 jlist`, come fa già `_comune.flottaViva`, e
**dichiarare la divergenza** col `.env` invece di nasconderla.

---

## 4-bis · 🟢 La presa di profitto — **FATTA il 17 agosto**, resta da osservare dal vivo

Commit `6be1fe7`. `lib/maker/presa-di-profitto.js` (puro) + 33 asserzioni che esercitano lo **scatto**
di ogni ramo attraverso il `decideClose` vero, cablata in `auto-close` prima di `already-covered`.
Decide sul **bid camminato**, mai sul mid.

**La misura che l'ha giustificata**: sui due fill del 16 agosto, **283 campioni di book su 354
minuti, ZERO istanti offrivano un'uscita realizzabile in guadagno** — e sotto l'ipotesi più generosa
possibile. Il guadagno visto sul pannello era la **differenza fra il mid e il bid**.
**E la scoperta che vale di più**: un take-profit **esisteva già** (ramo `marketAhead` di `planExit`,
3 agosto, con cricchetto) e non ha mai incassato niente perché è ancorato a `scoringMid`, cioè a un
numero che la misura dichiara non consumabile. Il buco non era «manca la regola» ma «la regola guarda
il numero sbagliato». **Non è mai stata esercitata su un fill vero**: il bot è fermo.

---

## 5 · `git push` bloccato — 31 commit solo locali

**Costo**: un disco perso li perde tutti.

Il remote è HTTPS e in `~/.ssh` c'è solo `authorized_keys`. Serve **una** delle due, e nessuna la può
fare un agente:
- chiave SSH: `ssh-keygen -t ed25519 -C "bot"`, pubblica su GitHub → *Settings → SSH keys*, poi
  `git remote set-url origin git@github.com:gasparatodiego-blip/prediction-market.git`
- oppure un PAT con scope `repo` in `~/.git-credentials` (`git config credential.helper store`)

---

## 6 · Fill parziale — **FATTO oggi**, resta da osservare dal vivo

Codificato come il totale (commit finale): gamba opposta per la sola quantità riempita, **residuo
cancellato subito**, slot liberato, scala dal primo parziale. **Non è mai stato esercitato su un fill
vero**: il bot è fermo da prima che ne arrivasse uno.

---

## 7 · 🔬 IL BANCO DEL CICLO COMPLETO — 37 regole su 91 arrivano a scattare

`node scripts/ricerca/banco-scenari.js` fa girare **il bot vero** — auto-close, auto-reprice,
manual-order, motore-unico, tutti i gate e i tetti — contro un venue simulato. Il seam è l'**adapter
del venue**, cioè il punto più profondo possibile: tutto ciò che sta sopra è produzione non toccata.
Sostituiti in `require.cache` cinque moduli e solo cinque — adapter, giornale, snapshot posizioni,
gestione manuale e allowlist del riprezzo. Le regole di mercato **non** sono sostituite: si passano
come `deps.books`/`deps.norm`, che `resolveMarketRules` già accetta.

**Il criterio non è il test unitario verde**: una regola è a posto solo se nel ciclo intero viene
RAGGIUNTA, SCATTA e produce l'EFFETTO. È la risposta al 16 agosto, quando ogni regola aveva il suo
test verde e in produzione non è scattato niente.

### Le 11 del GRUPPO 1 — dipendono solo da stato nostro, quindi avrebbero dovuto scattare

⚠ **Tre di queste sono rosse per la ragione giusta, e vanno lette diversamente dalle altre otto.**
Una lista in cui «rosso» vuol dire due cose diverse non si può usare.

| regola | file:riga | perché non scatta |
|---|---|---|
| `merge-esito-mancante` | `auto-close.js:1969` | ✅ **giustamente rossa**: è il RILEVATORE che scatta quando un obbligo di esito resta aperto. Se scattasse sarebbe un difetto nostro |
| `skip-cancel-non-collegato` | `auto-reprice.js:1830` | ✅ **giustamente rossa**: scatta solo se `deps.cancelOrder` non è una funzione, cioè su un errore di CABLAGGIO. agent40 la inietta sempre |
| `dry-run-validated` | `auto-close.js:2688` | ✅ **giustamente rossa**: è il ramo della modalità dry-run, e il banco invia sempre. Irraggiungibile per costruzione |
| `cancelled-top-of-book` | `auto-reprice.js:1845` | serve `d.action === 'cancel'` con gate top-of-book. Lo scenario «soli sul libro» c'è, ma la decisione non ci arriva |
| `reject-cancel-failed` | `auto-reprice.js:1845` | serve una cancellazione rifiutata dal venue **dentro** un ramo di cancellazione. Lo scenario c'è, il ramo no |
| `inseguimento-soppresso` | `auto-reprice.js:1768` | serve il gate `inseguimento-contro-mai-primo`: l'inseguimento che metterebbe primi sul libro |
| `inseguimento-ripreso` | `auto-reprice.js:1785` | la controparte del precedente |
| `modalita-chiusura-regole-attive` | `auto-close.js:1545` | scatta quando il tentativo immediato FALLISCE e le regole si aprono. Nel banco il tentativo riesce |
| `posizione-non-valutata` | `agent40:1161` | è la sorella di `posizione-mai-valutata` (che scatta) e richiede un timbro PRECEDENTE: il banco non timbra mai |
| `residuo-pronto-rivisitato` | `agent40:1228` | serve il registro dei residui popolato e una size tornata sopra il minimo |
| `rimpiazzata` | `auto-close.js:2677` | il rimpiazzo della gamba dopo un fill, con spazio sotto il tetto del mercato |

### Le 60 del GRUPPO 2 — dipendono da un evento esterno che il venue simulato non produce

| categoria | n | cosa manca al simulatore |
|---|---|---|
| errori e casi degeneri | 18 | letture illeggibili, eccezioni, dati malformati |
| ciclo di vita del mercato | 13 | risoluzione, chiusura, fine scala, scadenza del mercato |
| rete e rate limit | 10 | 429, `Retry-After`, timeout, esiti ambigui |
| interruttori e emergenze | 9 | KILL premuto, FERMA, guardiano che scatta |
| limiti di capitale saturi | 7 | tetti raggiunti, quota della finestra esaurita |
| concorrenza e corse | 3 | doppioni, chiavi bruciate, lock scaduti |

⚠ **La classificazione è un'ipotesi dichiarata, non una misura**: le parole chiave dicono da cosa
DIPENDE un ramo, non se sia raggiungibile. Per questo il gruppo 1 è corto e ogni voce porta
`file:riga` — la verifica costa una lettura. Si rigenera con
`node scripts/ricerca/classifica-regole-rosse.js`.

### I SEI difetti del banco trovati finora — un banco che mente è peggio di nessun banco

Tutti della stessa classe: **una fixture sbagliata che si maschera da regola morta**. Ogni volta il
sintomo puntava al posto sbagliato, e ogni volta la correzione è annotata nel sorgente.

1. **`maxSpread` scritto `rewardsMaxSpread`** — regole `readable:false`, OGNI ordine morto a
   `rules-unreadable`: il banco misurava il proprio fixture.
2. **`isManual` che tornava un booleano** invece di `{manual, readable}` — il ciclo usciva al primo
   gate a `manual-mode-unreadable`.
3. **`require.cache` su un percorso INESISTENTE** (`adapter_vero`) — `require()` risolve il percorso
   PRIMA di consultare la cache, e il fallimento arrivava travestito da `gate: adapter-threw`.
4. **`global.enabled` invece di `globalEnabled`** — il ciclo di riprezzo usciva a `disabled-global`
   **senza guardare un solo mercato**: 18 cicli che sembravano girare e non giravano.
5. **L'estrattore dell'inventario prendeva ogni stringa su una riga `outcome:`** — compresi
   l'operando di un confronto (`rp.action === 'rimpiazza'`, che è un'AZIONE) e il ripiego dentro un
   template (`reject-${gate || 'place'}`). Tre regole inesistenti in una lista da leggere a mano.
   ⚠ E prima ancora **non vedeva gli `outcome` dentro un ternario**: due regole vere non erano
   nemmeno inventariate — il banco non poteva dichiararle né rosse né verdi.
6. **`expiresAtMs` non esposto dagli ordini simulati** — `scaduto-senza-rinnovo` lo legge e usciva a
   `continue`: la regola risultava rossa per un campo mancante nella fixture.

⚠ E una **regressione vera** presa dal banco, che vale più delle sei: i due presidi di agent40 avevano
smesso di scattare **senza che nulla nel bot fosse cambiato**. Si appoggiavano alle posizioni lasciate
dalle fasi precedenti, e quando il merge ha smesso di fallire — cioè quando il banco è diventato più
FEDELE — le posizioni sparivano prima. **Uno scenario che dipende dagli avanzi di quello prima non è
uno scenario.**

---

## 8 · ❓ LA DOMANDA CHE RESTA: con 37 su 91, si può fare un giro controllato?

**La mia risposta è sì, a un mercato solo, e per una ragione che non è il numero.**

37 su 91 sembra poco e non lo è, perché le due metà non sono confrontabili. Delle 54 che non scattano,
**60 su 71 dipendono da eventi che in un giro controllato di poche ore non capiteranno** — un 429, un
mercato che si risolve, un KILL premuto — e tre delle undici restanti sono rilevatori di difetto che
**devono** restare rosse. Il numero che conta non è la copertura totale: è **quali** regole scattano.
E quelle che scattano oggi sono esattamente le sette che il 16 agosto sono costate soldi:

il fill parziale sotto il minimo trova una via d'uscita · il carico di ripiego copre il ciclo in cui
il venue non ha ancora pubblicato `avgPrice` · l'uscita insegue il bid e arriva a un prezzo colpibile
· l'attraversamento scatta con i quattro limiti e si dichiara · il merge on-chain esegue e riporta il
capitale · il rinnovo sopravvive al tetto orario · e una posizione che sparisce senza un nostro
ordine produce un allarme **subito** invece che il giorno dopo.

**Ciò che rende il giro difendibile non è la copertura, sono le cinture**, e sono numeri, non
promesse: un mercato solo, $61,25 di tetto, $150 di esposizione riconciliata, $100 di perdita
giornaliera che è un kill. Il caso peggiore è dell'ordine di un centinaio di dollari, contro
l'informazione che manca — che è **l'unica** che il banco non può dare: come si comporta il venue
vero. Il banco dice che, dato un venue che si comporta così, il nostro codice fa quello che crede di
fare. L'altra metà è il mercato, e si compra solo così.

**Le tre condizioni che porrei prima di armare**, e sono le cose che oggi non so:
1. **un mercato solo per davvero** — il pin `MAKER_LIVE_MIN_MARKET` **aggiunge** un'entrata, non
   restringe (`adapter.js:289`), e la allowlist ne porta già 4 più quelli con posizione. Servono tre
   scritture: selezione automatica spenta, allowlist svuotata, pin come cintura;
2. **`riconciliaCopertura` e il ripristino delle gambe non sono mai stati esercitati su un fill vero**
   — il banco li fa scattare, il mercato no;
3. **l'attraversamento è il permesso più pericoloso** e non è mai arrivato al venue vero. Il primo
   giro va guardato con `osserva-giro-controllato.js` acceso, non a posteriori.

**Il rischio che accetterei è quello dichiarato; quello che non accetterei è armare senza il punto 1**,
perché lì il numero che l'operatore ha in mente e quello che il codice applica sono diversi — ed è
esattamente la forma dell'errore che il 16 agosto è costato $2,84 su tre posizioni che nessuno stava
guardando.

---

## Stato del sistema — riverificato il 17 agosto 2026, 05:0xZ, DOPO il riavvio di agent40 e agent41

**Bot FERMO e disarmato.** `AVVIA: false` (dal 16/08 18:47:16Z, `cli/ferma`) · `MAKER_MODE=off` ·
`MAKER_PLACEMENT` vuota · `MAKER_ADAPTER_DRYRUN=true` · `MANUAL_ORDER_PLACEMENT` **assente** · KILL
spento · freno agent41 **INSERITO** (fail-closed: `REALLOC_SCHEDULER_DRY_RUN` assente) — letto da
`/proc/<pid>/environ` dei pid **174332** e **174326**, non dal `.env`. **Zero ordini a libro.**

**⚠ Il riavvio dal file NON ha riarmato niente, ed è stato verificato PRIMA di eseguirlo**:
`agents/ecosystem.config.js` non dichiara nessuna delle cinque cinture per quei due processi (porta
solo `MAKER_AUTO_REPRICE_POLL_MS`, `SBLOCCO_GRADINO6_ARMATO`, `REALLOC_SCHEDULER_ENABLED` e la
manopola della distanza), e il `.env` è neutralizzato. Le due sorgenti concordavano su `off` prima
del riavvio, e i processi vivi lo confermano dopo.

**⚠ La allowlist ha 4 mercati contro i 3 della selezione** — `0x33ec826f37` è quello in più. È lo
stesso disallineamento segnato ieri (allora era `0x776841ce`): il trigger a capitale fermo abilita
fuori dagli slot. Resta **aperto**.

⚠ **Anche il `.env` è stato neutralizzato** (`MAKER_MODE=off`, `MANUAL_ORDER_PLACEMENT` vuota): con
l'ecosystem pulito sarebbe stato lui a riarmare al primo riavvio, ed è gitignored, quindi non lo dice
nessuno.

**Posizioni residue** (nessuna direzionale):
- FL-02 `0x33ec826f` — **coppia completa** a 101¢, 57,1 share per lato. Vale $1,00/share alla
  risoluzione ⇒ **−$0,57 già determinati**. Non liquidare: due spread per recuperare 1¢.
- Hong Kong `0xe9b3e28d` — 6 share a carico 0,50, valore zero, **−$3,00**. **Non chiudibile**: sotto
  il `min_incentive_size` di 20, nessun ordine valido è piazzabile (§5.2 p.1).

**P&L delle operazioni di oggi: ≈ −$3,41** · premi incassati: **$0,00**.

**Il pulsante rosso è stato provato su un caso vero**: `node scripts/panic-cancel-all.js
--solo-cancella` ha cancellato 2 ordini su 2, zero alla rilettura.

---

## Come ripartire

```bash
cd /root/bot && claude --permission-mode auto
```
Poi, prima di qualunque cosa, leggere lo stato dai processi vivi e non dai file:
```bash
node scripts/cli/stato.js          # ⚠ legge le cinture dal .env: vedi punto 4
node scripts/ricerca/conformita.js --dry     # secondo parere sugli ordini vivi
```

**La regola che vale più di tutte, imparata oggi a caro prezzo**: *prima di modificare un ciclo vivo,
misura quanto spesso quel ciclo passa dal punto che stai toccando.* Le tre volte in cui l'ho fatto non
ho prodotto regressioni; le quattro in cui non l'ho fatto sì.

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

## 1 · La copertura continua dichiara ma non ripiazza

**Costo**: uno slot con una gamba sola non matura niente e, se quella gamba si riempie, diventa
esposizione direzionale — che è il modo in cui oggi si è persa la giornata.

`lib/maker/copertura-gambe.js` decide correttamente (`coperto` / `da-coprire` / `non-quotabile` /
`da-sostituire`, 13 asserzioni verdi) ed è cablato in `agent41.riconciliaCopertura`, ma quel
cablaggio **dichiara e basta**.

⚠ **NON rimettere la chiamata a `controlloCapitaleFermo`**: l'ho fatto stamattina e ha prodotto
**799 ricostruzioni del piano consecutive**, agent41 da 9 a 14 riavvii, e un **quarto mercato**
aggiunto alla allowlist (quel trigger abilita ciò che il PIANO sceglie, e il piano non conosce i tre
slot). La lezione, che vale oltre questo caso: *un riconciliatore che agisce sull'anello che osserva
non chiude più l'anello, e la frequenza del ciclo diventa la frequenza dell'azione.*

**La strada giusta**: aprire le gambe mancanti sui mercati **già in gestione**, senza ricostruire il
piano — cioè un piazzamento mirato che riusa il prezzo del motore, non un ricalcolo della selezione.

**Misurato il 17 agosto**, e conferma il quadro con tre fatti invece che con un'impressione:
`riconciliaCopertura` **è stata chiamata** a ogni ciclo (agent41 riga 2607, prima di `decidiTrigger`)
e **per progetto non piazza** — il suo commento lo dice (riga 1283): dichiara e forza il mini-ciclo,
che su **82 esecuzioni** ha risposto **49 volte `nessuna-azione`**.
**⚠ E scrive con `annuncia`, cioè nei log di pm2: ZERO record nel giornale del 16 agosto.** Non si
può quindi dire *quali* gambe abbia visto mancanti né *quando* — solo che è stata chiamata. Stessa
lacuna di §5.2 p.10: «non è che nessuno l'abbia guardato, è che nessuno lo scrive». **Chi ripara
questo punto scriva prima il record**, o la riparazione non sarà verificabile.
**⚠ E l'unico percorso che ripiazza davvero è stato saturato**: `rimpiazzo-gamba`
(`source: auto-close-on-fill`) ha fatto **133 `saltato-tetto-saturo`** e 21 `sotto-size-minima`
contro **3 `rimpiazzata`**. Il comportamento è corretto — non forzare il tetto è la regola — ma la
via di ritorno esisteva e per 133 volte su 157 non poteva percorrerla.

---

## 2 · Sette test rossi, tutti conseguenza delle modifiche di oggi

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

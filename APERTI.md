# Cosa resta aperto — chiuso il 16 agosto 2026, sera

Scritto perché una sessione nuova possa riprendere **senza rileggere tutto**. In ordine di quanto
costa se non si ripara. Lo stato del sistema al momento della chiusura è in fondo.

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

## 3 · Un percorso rigenera il BUY sulla stessa gamba

**Costo**: alto e non quantificato. Un ordine che ingrossa la gamba già scoperta mentre la scala
d'uscita cerca di ridurla.

Misurato due volte oggi sullo stesso token della posizione aperta: **`BUY 14¢ × 237,6`** e
**`BUY 14¢ × 152,4`** — fino a **quattro volte** la size della posizione. Cancellati entrambi a mano;
**sono ricomparsi**, quindi c'è un percorso che li rigenera e non l'ho identificato.

Il commit `9a1030b` (divieto di doppioni su token+lato) **non lo copre**: quello impedisce due ordini
identici, non un ordine di liquidità che cresce sul lato che possediamo. Da cercare partendo da
`source` nel giornale maker su quegli `orderId`.

---

## 4 · `stato.js` legge le cinture dal `.env`

**Costo**: una decisione sbagliata nel momento peggiore. In emergenza direbbe «sei fermo» mentre i
processi sono armati — verificato oggi: `.env` diceva `MAKER_PLACEMENT=` vuota mentre `/proc` diceva
`send`.

**Cura**: leggere `/proc/<pid>/environ` dei pid da `pm2 jlist`, come fa già `_comune.flottaViva`, e
**dichiarare la divergenza** col `.env` invece di nasconderla.

---

## 5 · `git push` bloccato — 26 commit solo locali

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

## Stato del sistema alla chiusura

**Bot FERMO e disarmato.** `AVVIA: false` · `MAKER_MODE=off` · `MAKER_PLACEMENT` vuota ·
`MAKER_ADAPTER_DRYRUN=true` · freno agent41 **INSERITO** — verificato su `/proc/<pid>/environ` dei
processi vivi, non sul `.env`. **Zero ordini a libro.**

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

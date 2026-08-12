# Il reset di agent41 distingue gli ordini per origine?

**12 agosto 2026 — SOLA DIAGNOSI. Nessuna riga di produzione è stata modificata, nessun processo
riavviato, il flag di dry-run di agent41 non è stato toccato.**

---

## Risposta breve

**Sì, distingue — e il meccanismo funziona, misurato sui dati veri.** Ma la classificazione ha un buco:
**una delle tre sorgenti automatiche è scritta con una stringa che non esiste**, quindi un'intera
categoria di ordini nostri viene registrata come «messa da una persona». Sono **4.686 righe** nel solo
giornale vivo.

---

## 1 · Il codice che decide

Sono quattro punti in fila. Il primo è l'unico interruttore.

### 1.1 · L'iniezione — `agents/agent41-realloc-scheduler.js:570`

```js
return runAllocationReset(
  { rows: pol.tenute, dryRunOnly },
  {
    …
    leggiOrigini: () => require('../lib/maker/origine-ordine').mappaOrigini(),
```

È l'unica cosa che accende la distinzione. Il commento accanto dichiara la ragione: agent41 «si sveglia
da solo ogni sei ore, e senza questa riga cancellerebbe anche gli ordini messi a mano dieci minuti
prima».

**L'altro chiamante non la inietta, ed è deliberato.** `app/api/maker/manual/bulk-allocate/route.ts:121`
chiama lo stesso `runAllocationReset` **senza** `leggiOrigini`: lì a premere il bottone c'è davvero
l'operatore, quindi «cancella tutto ciò che è a riposo» è ciò che ha chiesto. Sono gli unici due
chiamanti in tutto il repo.

### 1.2 · La separazione — `lib/maker/allocation-reset.js:169-186`

```js
const risparmiati = [];
if (typeof deps.leggiOrigini === 'function') {
  const { separaPerOrigine } = require('./origine-ordine');
  let mappa = null;
  try { mappa = deps.leggiOrigini(); } catch { mappa = null; }
  const sep = separaPerOrigine(daCancellare, mappa || new Map());
  risparmiati.push(...sep.daLasciare);
  daCancellare.length = 0;
  daCancellare.push(...sep.automatici);
```

Tre proprietà, tutte corrette:

- **senza la mano iniettata il comportamento è quello di prima, byte per byte** — il ramo non entra;
- **un registro illeggibile diventa `new Map()`**, cioè «tutto ignoto», cioè **non si cancella niente**.
  È il verso giusto: fra cancellare l'ordine di una persona e lasciare in piedi un ordine dello
  scheduler, solo il primo distrugge lavoro fatto apposta;
- **il capitale risparmiato viene dichiarato** (`notionalUsd` nella riga d'audit `risparmiati`), così il
  piano non lo conta due volte come libero.

### 1.3 · Il criterio — `lib/maker/origine-ordine.js:115-124`

```js
function separaPerOrigine(ordini, mappa) {
  for (const o of …) {
    const org = origineDiUnOrdine(o, mappa);
    if (org === ORIGINE_AUTO) automatici.push(…);   // ← si cancella SOLO questo
    else daLasciare.push(…);                        // ← manual-ui e ignota restano
  }
}
```

Passa **solo ciò che è provatamente automatico**. `ignota` sta con `manual-ui`.

### 1.4 · Il timbro, alla nascita — `lib/maker/origine-ordine.js:41-55`

```js
const SORGENTI_AUTOMATICHE = Object.freeze(['auto-reprice-band-exit', 'mm-tracking', 'auto-close']);

function origineDaSource(source, esplicita = null) {
  if (esplicita === ORIGINE_MANUALE || esplicita === ORIGINE_AUTO) return esplicita;
  if (SORGENTI_AUTOMATICHE.includes(source)) return ORIGINE_AUTO;
  return ORIGINE_MANUALE;          // ← il difetto per chi non è nell'elenco
}
```

Chiamata da `manual-order.js:828`, che scrive il campo nel registro append-only alle righe 1331 e 1348.
agent41 dichiara `origine: 'auto'` esplicitamente (`agent41:608` per il ciclo da 6 h, `:729` per il
mini-ciclo), quindi passa dal primo `if` e non dipende dall'elenco.

---

## 2 · La misura, sul giornale vivo (64,7 MB, 237.500 righe)

Coppie `source → origine` effettivamente scritte:

| `source` | `origine` registrata | righe | corretto? |
|---|---|---|---|
| `manual-ui` | `manual-ui` | 1.324 | ✅ è il pannello: una persona |
| `manual-ui` | `auto` | 214 | ✅ è agent41, che dichiara |
| `auto-reprice-band-exit` | `auto` | 103 | ✅ nell'elenco |
| **`auto-close-on-fill`** | **`manual-ui`** | **4.686** | ❌ **sbagliato** |

**La causa, in una riga.** L'elenco contiene `'auto-close'`; la costante vera è

```
lib/maker/auto-close-config.js:49 → const AUTO_CLOSE_SOURCE = 'auto-close-on-fill';
```

Le due stringhe non coincidono, `auto-close` non compare come `source` da nessuna parte, e `auto-close`
non dichiara mai `origine` esplicitamente. Quindi ogni ordine dell'uscita automatica cade nel difetto e
viene registrato come **manuale**. `git log -S` dice che la stringa è sbagliata **dal commit che ha
introdotto il meccanismo** (`cf685ca`): non è una regressione, non è mai stata giusta.

`mm-tracking` è invece scritto correttamente (`lib/maker/mm-tracking.js:31`), ma **non compare in
nessuna riga della coda viva**: la sua correttezza non è verificata dai dati, solo dal confronto delle
due stringhe.

---

## 3 · Cosa comporta

**L'effetto sul reset è nella direzione sicura, ma per la ragione sbagliata.** Le uscite di `auto-close`
proteggono una posizione: risparmiarle da un reset è probabilmente ciò che si vorrebbe comunque. Solo
che oggi non è una decisione — è il risultato di due stringhe che non si incontrano. Se qualcuno
correggesse l'elenco «per pulizia», il reset comincerebbe a **cancellare le uscite protettive** senza
che nessuno abbia deciso che vada bene, e la posizione resterebbe scoperta fino al giro successivo di
agent40 (~60 s).

**L'effetto sul registro è invece un danno vero e presente.** 4.686 righe dicono che una persona ha
piazzato ordini che nessuna persona ha toccato. Chiunque legga `origine` — un audit, il pannello, una
ricostruzione forense — riceve una risposta falsa, e il campo esiste **proprio** per rispondere a
quella domanda.

**Oggi il reset non ha nulla da cancellare** (bot FERMO + KILL, zero posizioni, zero ordini a riposo),
quindi non c'è un effetto in corso da rimediare.

---

## 4 · I punti da toccare — proposta, non implementata

Sono quattro, in ordine di importanza.

### P1 · Decidere *deliberatamente* cosa fare delle uscite di `auto-close` — `origine-ordine.js:41`

Non basta correggere la stringa: correggerla **cambia il comportamento** del reset. Le due strade sono
entrambe difendibili e vanno scelte, non subite:

- **(a)** aggiungere `'auto-close-on-fill'` all'elenco e accettare che il reset cancelli anche le uscite
  protettive (con il rischio dei ~60 s scoperti);
- **(b)** aggiungere la stringa **e** introdurre un terzo valore di origine — qualcosa come
  `auto-protettivo` — che il reset tratta come «non toccare». Così il registro dice la verità *e* il
  comportamento di oggi resta, ma perché qualcuno l'ha scelto.

Raccomandazione: **(b)**. Costa un valore in più e separa le due domande — «chi l'ha voluto» e «si può
cancellare» — che oggi sono la stessa cosa per accidente.

### P2 · Rendere impossibile la stessa svista — `origine-ordine.js:41`

L'elenco contiene stringhe letterali mentre le tre costanti esistono già
(`AUTO_CLOSE_SOURCE`, `AUTO_REPRICE_SOURCE`, `TRACKING_SOURCE`). **Importarle** invece di ricopiarle
avrebbe reso il difetto impossibile, ed è la stessa regola che il repo applica già al tetto per mercato
e alla soglia di credibilità. In più: un test che enumeri le corsie di piazzamento e pretenda che ogni
`source` usato sia classificato — oggi `origineDaSource` risponde `manual-ui` a **qualunque** stringa
sconosciuta, quindi una corsia automatica nuova che si dimentichi di dichiarare nasce silenziosamente
«manuale» e diventa non cancellabile dal reset.

### P3 · Un commento che dice l'opposto del codice — `origine-ordine.js:60-64`

L'intestazione di `mappaOrigini` dichiara «**Lettura intera e senza cache**: […] una cache incrementale
qui varrebbe un rischio di disallineamento in cambio di niente». Il corpo (righe 84-96) fa esattamente
il contrario: usa `scansiona` di `giornale-incrementale`, e il suo stesso commento dice «la mappa è
**ACCUMULATIVA e sopravvive fra le chiamate**». È il reperto che il rilevatore **D7** cerca. Il codice è
giusto (è la correzione del muro dei 512 MB, §5 punto 71); è il commento a essere rimasto indietro.

### P4 · Dichiarare il limite della finestra — `origine-ordine.js:84`

`mappaOrigini` legge **solo il file vivo**. Dalla rotazione (§5 punto 55) quello contiene gli ultimi
64 MB, cioè ~20 ore: un ordine più vecchio della coda risulta `ignota` e **non viene cancellato**.
In pratica è innocuo — un ordine a riposo muore per GTD in 23 minuti, quindi qualunque ordine vivo è
dentro la coda — ma la ragione per cui è innocuo va scritta, perché dipende da una costante (la finestra
GTD) che sta in un altro file e potrebbe cambiare.

---

## 5 · Cosa è stato escluso, e perché

- **il mini-ciclo non cancella niente** (`trigger-capitale-fermo`): non ha percorsi di cancellazione, quindi
  la domanda non lo riguarda;
- **`REALLOC_SCHEDULER_DRY_RUN` non è stato toccato** e resta inerte dov'è (§5 punto 3);
- **agent41 non è stato riavviato**, quindi tutto quanto sopra descrive il codice in `main` *e* quello
  nel processo vivo — che per `origine-ordine.js` e `allocation-reset.js` coincidono: nessuno dei due
  file è stato modificato oggi.

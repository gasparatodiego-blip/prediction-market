# I cinque test rossi — diagnosi, 8 agosto 2026

**Questo documento non corregge niente.** È l'indagine chiesta prima di decidere se e come intervenire.
Nessuno dei cinque test è stato toccato; nessun modulo di produzione è stato modificato per loro.

Cinque file di test falliscono da prima del lavoro dei giorni scorsi (verificato con `git stash` in due
sessioni distinte, e riverificato oggi: gli stessi cinque, né uno di più né uno di meno).

## Il verdetto in una riga

**Nessuno dei cinque segnala un bug di produzione.** Tutti e cinque sono `(a)` — test o rilevatori
rimasti indietro rispetto a un cambiamento legittimo, o fixture che non allestiscono il caso che
vogliono provare. **In particolare: il sospetto bug di unità di misura su `MIN_HORIZON_DAYS` NON
esiste** — la conversione giorni→minuti è dimensionalmente corretta; quello che è cambiato è il
*valore* della costante, non la sua unità. Il dettaglio è nel punto 1, perché merita di essere letto.

L'indagine ha però prodotto **una cosa da correggere**, ed è un commento: vedi «Il sottoprodotto».

| # | Test | Causa | Classe |
|---|---|---|---|
| 1 | `lib/maker/risk-classifier.test.js` | la costante `MIN_HORIZON_DAYS` è passata da 2 a 0,25 giorni, deliberatamente | (a) |
| 2 | `lib/rewards/scadenza-ereditata.test.js` | **stessa causa del #1** | (a) |
| 3 | `lib/maker/cancellazione-riconosciuta.test.js` | asserisce su dati di produzione ambientali che non ci sono più nella finestra letta | (a) |
| 4 | `lib/maker/dipendenze-collegate.test.js` | falso positivo del rilevatore su un ternario spezzato su più righe | (a) |
| 5 | `lib/maker/scaduto-senza-rinnovo.test.js` | la fixture usa un ordine che al primo giro viene riprezzato, quindi dimenticato di proposito | (a) |

---

## 1 · `risk-classifier.test.js` — il sospetto delle unità di misura, chiarito

**Cosa asserisce.** Che la soglia Safe, espressa in minuti, valga `MIN_HORIZON_DAYS × 24 × 60` **e**
che quel numero sia **2880** (cioè 2 giorni).

**Perché fallisce.** Il primo pezzo è vero, il secondo no: `SAFE_FLOOR_MINUTES` vale **360**.

**La causa.** `lib/rewards/horizon.js` porta `MIN_HORIZON_DAYS = 0.25`. Era 2, ed è stato cambiato con
il commit `0a0a845` («ricalibra sul consensus: un pavimento sul montepremi, e il tetto a 2 giorni che
escludeva l'archetipo»), con la motivazione scritta per esteso nella docstring della costante: i 21
maker di riferimento entrano su mercati con **vita mediana 0,44 giorni** (Q1 0,18 · Q3 0,80), verificata
contro il `closedTime` vero e non contro l'`endDate` di Gamma; su 25 mercati campionati 23 chiudono
entro un giorno e 25 su 25 entro due. Il pavimento a 2 giorni **escludeva per costruzione l'intero
archetipo** su cui il bot è modellato.

**Non è un bug di unità.** `MIN_HORIZON_DAYS` è in giorni ovunque, e `MIN_HORIZON_DAYS * 24 * 60` è la
conversione giusta in minuti. È cambiato il valore, non la scala. Il `2880` nel test è il vecchio valore
scritto a mano accanto alla formula: la formula regge, la costante di controllo no.

**Impatto in produzione, misurato e non dedotto.** `risk-classifier` è importato da **un solo posto**:
`app/components/LiquidityRewardsConsole.tsx` (`bucketizza`). È un modulo di **etichettatura**, non un
gate di piazzamento: decide se una riga finisce nel secchio Safe o Risk della console. Quindi l'effetto
del valore nuovo è che i mercati con scadenza fra 6 ore e 2 giorni sono etichettati Safe dove prima
erano Risk. **Nessun ordine cambia per questo.**

Il valore nuovo ha invece un effetto **reale** altrove, ed è quello per cui è stato cambiato:
`horizonVerdict` usa `MIN_HORIZON_DAYS` per dichiarare `resolved` un mercato troppo vicino alla
risoluzione, e quel verdetto **filtra il piano** quando `horizonFilter` è acceso (agent41 e il pannello
«Ottimizza»). Sotto le 6 ore un mercato viene rifiutato; fra 6 ore e 2 giorni no. **È la ricalibrazione
voluta, committata e documentata — non un guasto.**

**Classificazione: (a).** Il test va allineato al valore nuovo, e converrebbe farlo *derivando* il
numero invece di riscriverlo (`MIN_HORIZON_DAYS * 24 * 60` senza il `&& === 2880`), altrimenti la stessa
riga tornerà rossa alla prossima ricalibrazione.

---

## 2 · `scadenza-ereditata.test.js` — la stessa causa, in un altro vestito

**Cosa asserisce.** §5: «una scadenza vera e vicina — mezza giornata — questo sì che è un rifiuto, e
deve restare tale». Si aspetta `status: 'scartato'`, `reasonCode: 'orizzonte'`.

**Perché fallisce.** Il mercato viene **scelto**, con `horizon.state === 'ok'`.

**La causa: è il punto 1.** Mezza giornata sono 0,5 giorni; il pavimento è 0,25. Il mercato non è più
`resolved`. Non diventa nemmeno `short`, perché la fixture non ha nastro (0 fill ⇒ costo 0 ⇒ payback 0),
quindi l'orizzonte è pienamente `ok`.

**Impatto in produzione: nessuno di suo.** Il test misura il pavimento; il pavimento è quello del punto 1.

**Classificazione: (a).** La fixture va portata sotto il pavimento nuovo (per esempio `iso(0.1)`, ~2,4
ore), oppure derivata da `MIN_HORIZON_DAYS` invece che scritta a mano — di nuovo, per non doverla
rincorrere alla prossima ricalibrazione.

---

## 3 · `cancellazione-riconosciuta.test.js` — un test che interroga la produzione, e la produzione tace

**Cosa asserisce.** §5 legge **la coda (ultimi 4 MB)** di `data/polymarket-clob-audit.jsonl` e pretende
che ci sia almeno una `cancelOrder` con l'elenco `canceled` valorizzato, per provare sui dati veri che
il riconoscimento delle cancellazioni funziona.

**Perché fallisce.** In quella coda ci sono **0 `cancelOrder`**. Misurato: 22.602 righe, tutte
`listOpenOrders`. Il file intero pesa **136 MB**, quindi 4 MB sono l'ultimo ~3%; il bot è **FERMO** e non
cancella niente da giorni, mentre il polling degli ordini aperti continua a scrivere. Le ultime
cancellazioni vere sono uscite dalla finestra, spinte fuori dal rumore del polling.

**Non è un bug del codice.** Le prime quattro sezioni del file — quelle che provano il riconoscimento su
fixture — passano tutte. Fallisce solo la sezione che chiede alla macchina «e nella realtà è successo?».

**Classificazione: (a), con una sfumatura.** Un test che dipende da un dato ambientale dovrebbe
distinguere «ho guardato e non è successo» da «ho guardato e il comportamento è sbagliato»: il primo è
un campione vuoto, non un rosso. Le due strade sono dichiarare il campione vuoto come non-risultato,
oppure allargare la finestra letta finché non contiene almeno una cancellazione. La seconda costa I/O e
invecchia comunque; la prima è più onesta.

**Sottoprodotto utile:** la coda dell'audit del venue è oggi rumore di polling al 100%. Se un giorno si
volesse cercarci qualcosa, va cercato molto più indietro di 4 MB.

---

## 4 · `dipendenze-collegate.test.js` — il rilevatore non sa leggere un ternario andato a capo

**Cosa asserisce.** Che non esistano dipendenze **facoltative** (guardate con `typeof deps.X ===
'function'`, senza ramo alternativo) dentro moduli **vivi** che nessuno inietta. È il test nato per
prendere i comportamenti scritti, documentati, e mai collegati a niente.

**Perché fallisce.** Segnala `deps.resolveOwnOrders` in `lib/maker/manual-order.js`.

**La causa: è un falso positivo.** Quel codice il ripiego **ce l'ha**, e in bella vista
(`lib/maker/manual-order.js:907`):

```js
const lettore = (deps && typeof deps.resolveOwnOrders === 'function')
  ? deps.resolveOwnOrders
  : async (id) => listManualOrders({ marketId: id });
```

`scripts/dipendenze-scollegate.js` classifica **riga per riga**, e riconosce il ternario solo quando il
`?` sta sulla stessa riga del `typeof` (`scripts/dipendenze-scollegate.js:87`). Qui il `typeof` è a riga
907 e il `?` a riga 908, quindi il ripiego non viene visto e la dipendenza scivola da `con-difetto` a
`facoltativa`. Il commento del rilevatore racconta che al primo giro aveva già prodotto un falso
positivo sulla forma parentesizzata e l'aveva imparata: **questa è la variante con l'a-capo**.

**Impatto in produzione: nessuno.** Il ripiego funziona: senza iniettore, `placeManualOrder` legge i
propri ordini dal venue — che è esattamente il comportamento introdotto il 7 agosto («il pannello non si
accoda più a se stesso»).

**Classificazione: (a)**, sul rilevatore e non sul codice. La correzione naturale è far guardare al
rilevatore una piccola finestra di righe invece di una sola.

---

## 5 · `scaduto-senza-rinnovo.test.js` — la fixture non allestisce il caso che vuole provare

**Cosa asserisce.** §4: un mercato passato al motore di tracking **non viene letto**, quindi (i) non si
annuncia la morte dei suoi ordini e (ii) **l'ordine resta in memoria**, in attesa di essere riletto.

**Perché fallisce.** La (i) passa. La (ii) no: `ordiniVisti` è vuoto.

**La causa.** Non è il gate del tracking — quello si comporta bene, esce prima di `mercatiLetti.add` e
il ciclo di attribuzione della morte fa `continue` prima di dimenticare l'ordine. Il problema è **il
primo giro**: la fixture usa `ORDINE()` di difetto, che al giro 1 viene **riprezzato**
(`considered 1 · repriced 1`), e un ordine riprezzato viene dimenticato **di proposito** — il suo id è
morto, sostituito da quello nuovo. Al giro 2 non c'è più niente da trattenere.

Prova del contrario, sulla stessa funzione: con la fixture del §1 dello stesso file
(`ORDINE({ size: 30, sizeRemaining: 30 })`, dove il rinnovo è bloccato dalla size minima) il giro 1 dà
`repriced 0` e `ordiniVisti` contiene `0xb99f5566`. La proprietà che il §4 vuole provare **regge**: è la
fixture che non arriva a metterla alla prova.

**Impatto in produzione: nessuno.** Il codice fa la cosa giusta in entrambi i rami.

**Classificazione: (a).** Basta che il §4 parta da un ordine che sopravvive al primo giro.

---

## Il sottoprodotto: una cosa da correggere davvero

Non è un test — è un **commento che mente**, ed è su un modulo la cui intestazione promette
esattamente il contrario. `lib/maker/risk-classifier.js` apre con:

> «NESSUNA SOGLIA È INVENTATA QUI. Tutte e tre le soglie sono IMPORTATE dal posto che già le possedeva.
> Se una cambia là, cambia qui — che è l'unico modo perché "la soglia usata dal filtro" e "la soglia
> scritta nell'etichetta" non possano raccontare due numeri diversi.»

e poi, dodici righe sotto:

> `· MIN_HORIZON_DAYS = 2   lib/rewards/horizon.js`

più la docstring di riga 56: *«La soglia dell'ottimizzatore Safe, in minuti: 2 giorni.»* Il valore
importato è 0,25 giorni = 6 ore. Il meccanismo ha fatto il suo mestiere — la soglia usata *è* quella
importata — ma le due righe che la descrivono sono rimaste al 2, cioè proprio il caso che
l'intestazione dichiara impossibile.

**Non l'ho corretto**, perché questa sessione era di sola indagine e perché la correzione giusta va
decisa insieme al test: se il `2880` del test diventa derivato, anche questi due commenti vanno scritti
in modo che non possano invecchiare (per esempio nominando la costante invece del suo valore).

## Come è stata fatta l'indagine

Ogni causa è stata riprodotta eseguendo il codice, non dedotta leggendolo:

- punti 1 e 2 — letto il valore vivo di `MIN_HORIZON_DAYS` e ritrovato il commit che l'ha cambiato
  (`git log -S`), con la motivazione nella docstring;
- punto 3 — contate le operazioni nella coda letta dal test: `{"listOpenOrders": 22602}`, zero
  `cancelOrder`, su un file da 136 MB;
- punto 4 — letto il classificatore e individuata la riga (`dipendenze-scollegate.js:87`) che pretende
  il `?` sulla stessa riga del `typeof`;
- punto 5 — eseguito il ciclo vero con le due fixture affiancate: `repriced 1` con l'ordine di difetto,
  `repriced 0` e ordine in memoria con quello del §1.

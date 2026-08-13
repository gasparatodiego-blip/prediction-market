---
name: diagnosi
description: Usare per QUALUNQUE richiesta di misurare, verificare, capire perché, ricostruire un episodio o quantificare un costo SENZA cambiare niente — «perché è successo X», «quanto ci costa Y», «è vero che Z», «misura», «controlla», «indaga». Impone il perimetro di sola lettura, la distinzione fra misurato e inferito, e il formato del referto. NON usare quando c'è da correggere (vedi correzione-difetto) o da spostare un valore (vedi modifica-parametro).
---

# Diagnosi — sola lettura

Presupposto: `CLAUDE.md` è già in contesto. Qui c'è solo ciò che quel file **non** dice.

## Perimetro

Si può scrivere in **due posti soli**:
- `scripts/ricerca/` — lo script di misura;
- `data/ricerca/` — il suo output.

Tutto il resto è **sola lettura**: `lib/`, `agents/`, `app/`, `.env`, schema Prisma, database, i file
di stato in `data/`. Una sessione di diagnosi **non corregge**, nemmeno il difetto da una riga che
trova per strada — quello si annota (vedi *Referto*).

Lo script di ricerca è codice usa-e-getta ma resta nel repo: è la prova del numero. Va committato
insieme al suo output, o il referto non è verificabile.

> Attenzione al costo: il piano gira in un processo figlio da ~1 GB. Su questa macchina c'è poca
> memoria libera — misurare prima, e preferire la finestra corta quando la domanda lo consente.

## La regola che conta: misurato ≠ inferito

Ogni numero del referto porta la sua natura. Tre righe da rispettare sempre:

1. **Un riassunto può nascondere una coda.** Prima di concludere da una media o da una mediana,
   guardare la **distribuzione**. Una mediana non descrive un processo a raffiche: se il fenomeno
   arriva a ondate, la mediana descrive la quiete fra un'ondata e l'altra.
2. **Sotto le 200 osservazioni per fascia non si conclude.** Si dichiara `n`, si dice che la fascia
   non è conclusa, e si aggrega finché la soglia è raggiunta — invece di stringere le fasce.
   (È già la pratica del repo: vedi il modo in cui sono scritte le voci di §5.2.)
3. **Manca strumentazione ⇒ si dice quale campo e dove.** Non si stima al posto suo. La forma utile è
   «per rispondere servirebbe `<campo>` scritto in `<file>` da `<chi>`; oggi non esiste, quindi la
   domanda non è rispondibile dallo stato salvato».

Corollario che vale in questo repo più che altrove: un numero letto da un log **non** è un numero
misurato finché non si sa quale ramo di codice l'ha prodotto. Due piani diversi (libero e ristretto)
scrivono righe di log identiche nella forma.

## Verificare la premessa della domanda

Se l'operatore chiede «perché succede X», il **primo** passo è verificare che X succeda. Se non
succede — o succede per un motivo diverso da quello implicito nella domanda — si dice questo **prima**
di rispondere, e si risponde alla domanda vera. Una spiegazione elegante di un fatto inesistente è il
modo più veloce di far prendere una decisione sbagliata.

## Correggersi è obbligatorio

Se a metà lavoro i dati smentiscono la conclusione verso cui si stava andando, la smentita **entra nel
referto in chiaro**: «stavo concludendo A, la misura B lo esclude, la conclusione è C». Non si
consegna la conclusione comoda perché era già scritta. Vale anche quando l'ipotesi comoda era
dell'operatore.

Se la prova non basta a decidere fra due cause, si dicono **entrambe** con il loro grado di certezza,
invece di sceglierne una per chiudere il referto.

## Formato del referto

1. **Cosa ho misurato** — numeri, con `file:riga` o il file di `data/ricerca/` che li contiene.
2. **Cosa NON sono riuscito a misurare, e perché** — dato mancante, campione insufficiente,
   strumentazione assente, stato non ricostruibile. Questa voce non si salta mai: se è vuota,
   quasi sempre significa che non si è guardato abbastanza.
3. **Difetti nuovi trovati** — annotati come punti aperti numerati in §5.2 di `CLAUDE.md`, con file e
   riga, seguendo le regole di §7. **Mai corretti in una sessione di diagnosi**: l'annotazione è il
   deliverable.

## Regole comuni

**Conferme obbligatorie — si chiedono SEMPRE, ogni volta, anche se già concesse nella stessa sessione:**
- riavvio, stop, delete o reload di qualunque processo pm2 (§2 regola 2);
- qualunque ordine reale piazzato o cancellato (§2 regola 3);
- modifiche a schema Prisma, database o `.env` (§2 regola 1 le **vieta**: senza istruzione esplicita
  in chat non si procede comunque);
- modifiche a qualunque parametro di configurazione non autorizzato esplicitamente nel prompt;
- disattivazione del KILL (`data/safety-kill-switch.json`) o cancellazione del latch del guardiano
  (`data/guardian-state.json`): la sua **assenza** significa «guardiano in servizio e mai scattato»,
  quindi cancellarlo non azzera uno stato, cancella una prova.

**Mai chiedere — si fa e basta:**
- `npm run build`;
- script di sola lettura in `scripts/ricerca/` con output in `data/ricerca/`;
- chiamate API in lettura;
- qualunque scelta che non tocca capitale reale né sicurezza: si prende la più sensata, si procede,
  e la si annota **solo** nel riepilogo finale (§6).

**Chiusura.** Se il lavoro ha toccato logica operativa, **fermarsi prima di riavviare** ed elencare i
riavvii pendenti raggruppati in fondo, che l'operatore approva in blocco — stesso formato di §5.1.
Aggiornare `CLAUDE.md` secondo §7, poi commit e push.

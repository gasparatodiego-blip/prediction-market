---
name: correzione-difetto
description: Usare quando c'è un bug da sistemare — un comportamento sbagliato, una difesa che non scatta, un ramo che fallisce aperto, una protezione presente su un percorso e assente sul gemello. Impone di provare e quantificare il difetto prima di toccarlo, di dichiarare quante volte una difesa riattivata sarebbe scattata nelle ultime 48 ore, il fail-closed, e i test sulla proprietà generale. NON usare per spostare un valore corretto (vedi modifica-parametro) né per misurare senza cambiare (vedi diagnosi).
---

# Correzione di un difetto

Presupposto: `CLAUDE.md` è già in contesto. Le classi di difetto che si ripetono in questo repo sono
tabulate in §5-bis — **leggerle prima di scrivere codice**: sei volte `Number(null) === 0`, cinque
volte una costante ricopiata, cinque volte una protezione presente su un percorso e assente sul
gemello. Un difetto nuovo appartiene quasi sempre a una di quelle famiglie.

## Prima di correggere: provare che esiste, e quanto costa

1. **La prova.** Il caso vero, con `file:riga` del ramo che decide e la riga di giornale che lo mostra
   accadere. Un commento che descrive il difetto non è una prova: in questo repo il commento che
   racconta un comportamento inesistente è a sua volta una classe di difetto (D7, 4+ occorrenze).
2. **Il costo.** In dollari, in ordini, in ore di esposizione, in occorrenze. «Sembra sbagliato» non è
   un costo.
3. **Se la prova non è netta, non si corregge e lo si dice.** Una correzione su un difetto non provato
   sposta il comportamento senza sapere in quale verso, e toglie all'operatore la possibilità di
   decidere. Meglio un punto aperto numerato in §5.2 che una modifica speculativa.

## Una difesa che torna attiva va quantificata PRIMA

Se la correzione riguarda una difesa che finora **falliva chiusa** — moriva in un `catch`, non era
cablata, asseriva l'assenza — allora dopo la correzione quella difesa **agisce su capitale vero**.
Prima che l'operatore la veda scattare, va detto:

- **quante volte sarebbe scattata nelle ultime 48 ore**, contate sul giornale;
- **quante di quelle sarebbero state corrette** e quante falsi positivi, una per una;
- **se la finestra osservabile è più corta di 48 ore, dirlo** — «il modulo è in servizio da N ore,
  quindi la finestra è N e non 48; prima non esiste nulla nel giornale»;
- **cosa succede dopo lo scatto**: esiste un riarmo automatico o serve una mano umana?

«Sarebbe scattata» ≠ «sarebbe stata utile»: una difesa che ferma le aperture mentre il bot non stava
aprendo trasforma «prova e non ci riesce» in «dichiara di essersi fermato». Va detto anche questo.
Il modello di riferimento è il riquadro del gradino 6 in §5.1 — si scrive in quella forma.

## Fallire chiuso

Nel dubbio l'azione **non** si esegue. Mai il contrario. In concreto:
- dato illeggibile ⇒ non si piazza, non si riarma, non si cancella stato;
- lettura mancante ⇒ il tetto resta applicato, non viene esentato;
- verdetto `ignoto` ⇒ non diventa né un sì né un no, e non tocca niente.

L'eccezione è **ridurre l'esposizione**: cancellare e chiudere devono restare possibili anche quando
il resto è bloccato. Una protezione che impedisce di uscire non è una protezione (vedi
`modifica-parametro`, «aperture ≠ chiusure»).

Attenzione al fail-**open** travestito: un valore di difetto che a valle significa «nessun limite»
(`null` che vale «nessun tetto», `Number(null)` che vale `0`) allarga il permesso invece di
stringerlo. È il difetto più ricorrente del repo.

## Test

Il test difende la **proprietà generale**, non il caso singolo che ha aperto l'indagine, e **deve
fallire sul codice vecchio** — verificarlo davvero, non assumerlo. Un test che passa anche prima della
correzione non sta misurando la correzione.

Non asserire su `git diff`, non contare occorrenze, filtrare i commenti nei test strutturali (§5.3):
un commento che *racconta* la riga corretta ha già fatto passare un test che cercava la stringa nel
sorgente.

## Se il difetto si rivela più rischioso di come è stato descritto

Fermarsi e spiegare, invece di forzare. Segnali che impongono la fermata:
- la correzione tocca un percorso che piazza o cancella, e il prompt non lo prevedeva;
- il difetto è la causa *a valle* di un difetto più grande a monte, e correggerlo qui lo nasconde;
- la correzione rende attiva una difesa il cui scatto richiede una mano umana per ripartire;
- il caso vero mostra esposizione direzionale aperta che nessuno aveva contato.

In quei casi si consegna la diagnosi completa, la correzione **proposta ma non applicata**, e si
lascia decidere. È già la scelta fatta in §5.2 p.21: difetto annotato con file e riga, non corretto.

## Regole comuni

**Conferme obbligatorie — si chiedono SEMPRE, ogni volta, anche se già concesse nella stessa sessione:**
- riavvio, stop, delete o reload di qualunque processo pm2 (§2 regola 2);
- qualunque ordine reale piazzato o cancellato (§2 regola 3);
- modifiche a schema Prisma, database o `.env` (§2 regola 1 le **vieta**: senza istruzione esplicita
  in chat non si procede comunque);
- modifiche a qualunque parametro di configurazione non autorizzato esplicitamente nel prompt — una
  correzione che «già che c'è» sposta anche una soglia è due lavori, non uno;
- disattivazione del KILL (`data/safety-kill-switch.json`) o cancellazione del latch del guardiano
  (`data/guardian-state.json`): la sua **assenza** significa «guardiano in servizio e mai scattato»,
  quindi cancellarlo non azzera uno stato, cancella la prova di uno scatto.

**Mai chiedere — si fa e basta:**
- `npm run build`;
- script di sola lettura in `scripts/ricerca/` con output in `data/ricerca/`;
- chiamate API in lettura;
- qualunque scelta che non tocca capitale reale né sicurezza: si prende la più sensata, si procede,
  e la si annota **solo** nel riepilogo finale (§6).

**Chiusura.** Una correzione tocca per definizione logica operativa: **fermarsi prima di riavviare** ed
elencare i riavvii pendenti raggruppati in fondo, che l'operatore approva in blocco — stesso formato di
§5.1, marcando con ⚠ quelli che **armano una difesa che finora falliva chiuso**. Aggiornare `CLAUDE.md`
secondo §7, poi commit e push.

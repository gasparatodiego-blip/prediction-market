---
name: modifica-parametro
description: Usare quando si sposta un valore — una soglia, un tetto, una cadenza, una frazione, un timeout, una costante di configurazione — sia in `lib/`, sia in `ecosystem.config.js`, sia in `.env`. Impone la sequenza trova→verifica copie→verifica presidi→modifica, il punto di verità unico, la misura sul board vivo prima dei riavvii, e la dichiarazione su cosa entra in servizio senza riavvio. NON usare per correggere un comportamento sbagliato (vedi correzione-difetto).
---

# Modifica di un parametro

Presupposto: `CLAUDE.md` è già in contesto. Il tetto per mercato e le sue derivate sono descritti in
§4.2; la griglia del piano in §4.3. Qui c'è solo il **metodo**.

## Sequenza obbligatoria — la modifica è il passo 4, non il primo

1. **Dove vive e chi lo legge.** Trovare la dichiarazione e **tutti** i consumatori. Un `grep` sul
   nome della costante non basta: cercare anche il **valore** in cifre, perché la copia pericolosa è
   quella che ha perso il nome.
2. **Copie e derivate.** Esiste un secondo modulo con lo stesso numero? Esiste un valore *calcolato*
   dal vecchio (un margine, una metà, un pavimento, una finestra)? Le derivate si muovono da sole solo
   se sono scritte come derivate.
3. **Presidi tarati implicitamente sul valore vecchio.** È il passo che si salta. Un pavimento, un
   minimo, un tetto per ordine o un test possono essere stati scelti *sapendo* quanto valeva il
   parametro, senza dirlo. Se dopo la modifica un presidio diventa irraggiungibile o non morde più,
   quella non è una conseguenza: è un guasto.
4. **Solo ora si modifica.**

## Un solo punto di verità

Se il valore vive in più moduli, la modifica deve **lasciarne uno solo** che tutti importano. La
copia è il difetto, non solo il numero sbagliato: è la classe di difetto D1 di `CLAUDE.md`
(«costante ricopiata invece che importata», 5+ occorrenze). Correggere il valore in due posti e
lasciarli due significa aver programmato la prossima divergenza.

## Misurare prima dei riavvii

L'effetto si misura sul **board vivo prima** di riavviare qualsiasi cosa — con uno script di sola
lettura in `scripts/ricerca/`, output in `data/ricerca/`. Dopo il riavvio la misura non distingue più
l'effetto del parametro da quello del riavvio, e la domanda «quanto è cambiato» resta senza risposta.

La forma utile: quanti mercati / righe / dollari **prima** e **dopo**, sullo stesso board, con lo
stesso capitale.

## Una leva alla volta

Se il prompt chiede di muovere due parametri insieme, **dirlo e chiedere quale muovere per primo**.
Due leve insieme rendono illeggibili le 24 ore di dati successive, ed è già stata la ragione dichiarata
per non applicare una modifica (§5.2 p.26). *(Questa è l'eccezione dichiarata a «nessuna domanda a
metà lavoro» di §6: qui la domanda non è una richiesta di decisione, è il presupposto perché la misura
successiva significhi qualcosa.)*

## Aperture ≠ chiusure

Un tetto pensato per limitare l'**apertura** di esposizione nuova, applicato a un'azione che
esposizione non ne apre — una chiusura, un rinnovo, un riposizionamento, un appaiamento — **non è un
presidio: è un difetto**. Produce esattamente ciò che dovrebbe impedire, cioè gambe scoperte.

È già successo due volte ed è stato corretto (§5-bis p.133, tetto per mercato; p.147, tetto per
ordine), e una terza è **ancora aperta** (§5.2 p.21, il pavimento di profondità sui rinnovi). Prima di
spostare qualunque tetto: verificare che il percorso di riduzione dell'esposizione sia esente, e che
l'esenzione sia **provata sull'ordine esatto**, non concessa per categoria.

## Test

Il test fissa il valore **e le sue derivate**, così una divergenza futura fallisce invece di passare
in silenzio. Non fotografa il working tree e non conta occorrenze (§5.3): difende la **proprietà** —
«la derivata è ancora `f(base)`», «i quattro consumatori leggono la stessa funzione» — non il numero
in sé.

## Cosa entra in servizio senza riavvio — va DICHIARATO ogni volta

Due comportamenti diversi, e la modifica deve dire quale vale per il parametro toccato:

- **Rileggono il codice da disco a ogni giro** (nessun riavvio necessario, in servizio subito):
  `lib/rewards/allocator.js`, `quotabilita.js`, `realistic-estimate.js`, `plan-to-orders.js` e le loro
  dipendenze — vivono nel processo figlio del piano (`RUNNER_PIANO`, `/api/rewards/allocate`). Vedi §5.3.
- **Tengono il valore in memoria** (serve il riavvio, e fino a quel momento il vecchio valore è ancora
  quello che decide): `agent40` e `agent41`, cioè il cablaggio e le righe di log.

Conseguenza pratica: una modifica può essere **parzialmente in servizio**, con il pianificatore sul
valore nuovo e il motore su quello vecchio. Questa divergenza si dichiara — nel referto e in §5.1 —
insieme al verso in cui sbaglia. Un log di produzione che mostra il valore vecchio non è la prova che
la modifica non è arrivata: può essere solo il lato in memoria.

## Regole comuni

**Conferme obbligatorie — si chiedono SEMPRE, ogni volta, anche se già concesse nella stessa sessione:**
- riavvio, stop, delete o reload di qualunque processo pm2 (§2 regola 2);
- qualunque ordine reale piazzato o cancellato (§2 regola 3);
- modifiche a schema Prisma, database o `.env` (§2 regola 1 le **vieta**: senza istruzione esplicita
  in chat non si procede comunque);
- modifiche a qualunque parametro di configurazione **non autorizzato esplicitamente nel prompt** —
  compresi i parametri vicini che sembrano «da allineare»;
- disattivazione del KILL (`data/safety-kill-switch.json`) o cancellazione del latch del guardiano
  (`data/guardian-state.json`): la sua **assenza** significa «guardiano in servizio e mai scattato».

**Mai chiedere — si fa e basta:**
- `npm run build`;
- script di sola lettura in `scripts/ricerca/` con output in `data/ricerca/`;
- chiamate API in lettura;
- qualunque scelta che non tocca capitale reale né sicurezza: si prende la più sensata, si procede,
  e la si annota **solo** nel riepilogo finale (§6).

**Chiusura.** Il codice qui tocca sempre logica operativa: **fermarsi prima di riavviare** ed elencare
i riavvii pendenti raggruppati in fondo, che l'operatore approva in blocco — stesso formato di §5.1,
con la colonna «cosa entra in servizio». Aggiornare `CLAUDE.md` secondo §7, poi commit e push.

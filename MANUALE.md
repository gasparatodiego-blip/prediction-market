════════════════════════════════════════════════════════════════════════════════
MANUALE OPERATIVO DEL BOT DI LIQUIDITY REWARDS SU POLYMARKET
Comportamento completo, aggiornato al 18 agosto 2026 (sera)
════════════════════════════════════════════════════════════════════════════════

COSA FA QUESTO BOT, IN UNA FRASE

Piazza ordini di acquisto FERMI su entrambi i lati di un mercato di previsione
(il lato SI e il lato NO), li tiene dentro la fascia di prezzo che il venue
premia, e incassa i premi di liquidità che il venue paga a chi tiene ordini a
riposo. I premi si pagano sugli ordini CHE ASPETTANO, non su quelli che vengono
eseguiti: per questo bot l'esecuzione di un ordine è un COSTO, non un ricavo.
Quando un ordine viene eseguito il bot non ha guadagnato: ha una posizione da
gestire, e tutto ciò che segue serve a chiuderla senza perderci.

Il capitale è reale. Ogni numero in questo manuale è letto dal codice in
servizio, non da una specifica.

════════════════════════════════════════════════════════════════════════════════
PARTE PRIMA — LE DIECI REGOLE CONCORDATE
════════════════════════════════════════════════════════════════════════════════

Sono la specifica del bot. Chi ne cambia una cambia il bot.

REGOLA 1 — QUANTI MERCATI
Il numero di mercati che il bot tiene attivi contemporaneamente lo decide
l'operatore prima di ogni sessione: uno, due o tre. QUALI mercati li sceglie il
bot. Il numero è scritto in un posto solo — una variabile d'ambiente del
processo che esegue la selezione — e si legge dal processo vivo, non dal file di
configurazione: fra i due può esserci divergenza finché il processo non viene
riavviato. Un valore che non si capisce (vuoto, negativo, decimale, una parola)
vale il difetto, che è tre; non vale mai zero, perché un errore di battitura non
deve poter fermare il bot in silenzio. Il massimo consentito è tre.
La composizione del capitale si DERIVA dal numero, non si dichiara a parte: con
due o tre mercati, uno deve avere una soglia premiante bassa e gli altri alta;
con un mercato solo non c'è composizione da rispettare e il posto ammette
qualunque mercato ammissibile. Ridurre il numero non chiude niente: governa
quanti mercati si APRONO, e il rientro avviene per consumo.

REGOLA 2 — SCELTA
Il bot scarta i mercati la cui soglia premiante costa più di 61,25 dollari,
quelli che scadono entro 24 ore, e quelli della famiglia meteo. Fra i restanti
ordina per rendimento NETTO, cioè tenendo conto della concorrenza già presente
nella fascia premiante: un mercato con un montepremi enorme ma cinquantamila
share altrui davanti rende meno di un mercato piccolo con trecento.

REGOLA 3 — INGRESSO
Si entra con due gambe, SI e NO, della STESSA quantità, decisa insieme per
entrambe. Si piazzano il più esternamente possibile pur restando dentro la
fascia premiata, perché al bordo il rischio di essere eseguiti è minimo mentre
il premio continua a maturare. In pratica: circa 60 dollari per mercato, circa
61 share per lato.

REGOLA 4 — RIPREZZO
Il bot guarda il LIBRO degli ordini, non solo il prezzo medio. Riprezza se il
prezzo medio esce dalla fascia premiante. E riprezza ANCHE se la profondità
davanti ai suoi ordini si erode — cioè se la quantità di ordini altrui che lo
separa dall'esecuzione crolla — senza aspettare che il prezzo si muova. In quel
caso non arretra di poco: CANCELLA e resta fuori dal libro, al massimo cinque
minuti. Se dopo cinque minuti la profondità non è tornata, rientra comunque e lo
dichiara. Fra un'uscita e l'altra sullo stesso mercato e lato passa almeno un
minuto. Se la profondità non è leggibile, non fa niente e lo dichiara.

REGOLA 5 — FILL PARZIALE
Se un ordine viene eseguito solo in parte, il bot copre la quantità eseguita
comprando l'altro lato per quella quantità ESATTA. E cancella SEMPRE la parte
residua dell'ordine che ha prodotto l'esecuzione — a ogni giro finché è lì, non
solo la prima volta — anche se quella parte è sotto la quantità minima. Poi
fonde la coppia.

REGOLA 6 — RESIDUO SOTTO IL MINIMO
Una posizione più piccola della quantità minima del venue si chiude sempre,
anche accettando di attraversare il libro. Se vendere non è possibile, il bot
può comprare l'altro lato per completare la coppia e fonderla, anche pagando più
di quanto la coppia renderà. Il limite è in DOLLARI: non spende per uscire più
di quanto la posizione valga, e comunque mai più di 5 dollari. Se nemmeno così
si chiude, lo dichiara e lascia stare: si aspetta la risoluzione del mercato.

REGOLA 7 — FILL TOTALE
Se un ordine viene eseguito per intero, il bot compra subito l'altro lato
pagando il prezzo di vendita corrente, purché le due gambe insieme costino meno
di 101 centesimi. Se costano di più, mette un ordine fermo al prezzo massimo che
rispetta quel tetto — un ordine che intanto matura premio — e aspetta 30 minuti.
Se dopo 30 minuti la coppia non si è chiusa, parte la scala d'uscita: l'ordine di
vendita può scendere fino al prezzo di carico, e dopo 60 minuti fino al 5% sotto
il carico.

REGOLA 8 — MERGE
Quando la coppia è completa — stessa quantità su SI e NO — si fonde subito,
sempre, senza limiti di prezzo. Una coppia completa vale un dollaro per share
alla risoluzione qualunque cosa faccia il prezzo, e la fusione lo incassa
immediatamente senza attraversare nessuno spread. Il tetto di 101 centesimi vale
SOLO per l'acquisto della gamba mancante, mai per la fusione.

REGOLA 9 — ROTAZIONE
Il bot sostituisce il mercato peggiore solo se il nuovo rende almeno 50 centesimi
al giorno in più, oppure il 25% in più. Non tocca mai un mercato con una
posizione aperta o una coppia incompleta: quello esce dal conteggio dei mercati
attivi ma resta gestito fino a coppia chiusa. Non tocca mai un mercato con
ordini a riposo. Se il rendimento netto di uno dei due non è misurabile, non
sostituisce e non si fa sostituire.

REGOLA 10 — KILL
Se la perdita realizzata nella giornata raggiunge 100 dollari, il bot cancella
tutti gli ordini a riposo E chiude le posizioni: le coppie complete le fonde, le
gambe scoperte le vende a mercato, le gambe sotto la quantità minima restano e
vengono dichiarate. Poi si ferma e non riapre.

DUE PUNTI IN CUI IL CODICE È PIÙ PRUDENTE DELLA REGOLA, PER SCELTA
· la Regola 3 dice «un tick di margine dal bordo»; il codice tiene il più largo
  fra un tick e il 22% della larghezza della fascia. Su una fascia stretta i due
  coincidono; su una larga il codice sta più lontano dal prezzo medio.
· la Regola 10 dice «non riapre fino al giorno dopo»; il codice non riapre
  affatto. Dopo un kill il bot resta fermo finché una persona non cancella a mano
  il segnale di blocco.

════════════════════════════════════════════════════════════════════════════════
PARTE SECONDA — TUTTI I CASI
════════════════════════════════════════════════════════════════════════════════

Ogni caso ha la stessa forma: quando succede, cosa fa il bot, cosa NON fa, e cosa
succede se il dato necessario non è leggibile. Quest'ultima riga è la più
importante: quasi tutti i guasti veri di questo bot sono nati da un dato mancante
trattato come se valesse zero.

────────────────────────────────────────────────────────────────────────────────
A · SCELTA DEI MERCATI E INGRESSO
────────────────────────────────────────────────────────────────────────────────

A1 · IL BOT DEVE SCEGLIERE SU QUALI MERCATI LAVORARE
Quando: a ogni ciclo lungo (ogni sei ore) e a ogni controllo del capitale fermo
(ogni due minuti circa).
Cosa fa: prende l'elenco dei mercati premiati pubblicato dal venue, scarta quelli
che chiedono più di 61,25 dollari per raggiungere la soglia premiante, quelli che
scadono entro 24 ore, quelli oltre l'orizzonte del piano, e quelli della famiglia
meteo. Ordina i restanti per rendimento netto stimato e riempie i posti
disponibili rispettando la composizione derivata dal numero di mercati.
Cosa NON fa: non apre nessun ordine. Decide SU QUALI mercati, mai SE operare:
servono comunque, e indipendentemente, l'interruttore di avvio, l'assenza del
blocco d'emergenza e le protezioni di armamento.
Se il dato non è leggibile: elenco dei mercati illeggibile o vuoto ⇒ nessuna
decisione, e soprattutto nessuno viene TOLTO — un elenco che non si legge farebbe
sembrare scaduto tutto il mondo. Posizioni non leggibili ⇒ nessuna decisione,
perché senza non si può dimostrare che una posizione sia chiusa. La scadenza di
UN singolo mercato non determinabile ⇒ quel mercato è escluso, e qui il verso è
opposto di proposito: nei primi due casi l'ignoranza riguarda tutto l'insieme e
la risposta è non agire, qui riguarda un mercato solo, e non sapere quando
finisce è già una ragione per non entrarci.

A2 · UNO SCAGLIONE DELLA COMPOSIZIONE NON HA CANDIDATI
Quando: la composizione chiede un mercato con soglia premiante bassa e sul
listino non ce n'è nessuno ammissibile.
Cosa fa: lascia il posto VUOTO e lo dichiara.
Cosa NON fa: non lo riempie con un mercato dell'altro scaglione. Sostituire
porterebbe il capitale impegnato da 147 a 183,75 dollari, cioè cambierebbe in
silenzio la cifra che l'operatore ha deciso.

A3 · IL BOT APRE LE DUE GAMBE
Quando: c'è capitale libero, il bot è avviato, il blocco d'emergenza è spento e
il piano contiene una riga finanziabile.
Cosa fa: calcola UNA quantità per entrambe le gambe, dividendo il capitale della
riga per il costo della coppia. Sceglie per ciascun lato il prezzo più lontano
dal prezzo medio che resti dentro la fascia premiante, tenendosi un margine dal
bordo. Poi valuta ENTRAMBE le gambe contro tutti i limiti PRIMA di inviarne una
sola.
Cosa NON fa: non invia mai una gamba sola all'ingresso. Se una delle due non
passa un limite, non ne parte nessuna: una gamba orfana è esposizione
direzionale, che è esattamente ciò che questo bot esiste per evitare.
Se il dato non è leggibile: regole del mercato non leggibili, prezzo medio non
affidabile o fascia premiante non pubblicata ⇒ non si quota. Non si indovina mai
una fascia.

A4 · IL BOT È SOLO SU UN LATO DEL LIBRO
Quando: sul lato dove vuole piazzare non c'è nessun altro ordine.
Cosa fa: si mette al bordo ESTERNO della fascia premiante, cioè al prezzo
peggiore che ancora paga premio. Senza concorrenti sarebbe primo comunque, quindi
tanto vale stare il più lontano possibile dall'esecuzione.
Cosa NON fa: non si mette al tocco. Appena compare un concorrente torna a
mettersi un tick dietro di lui.
Se il dato non è leggibile: se la fascia non ha prezzi validi, non si quota.

A5 · IL PREZZO SAREBBE IL MIGLIORE DEL LIBRO
Quando: mettersi dove il calcolo vorrebbe significherebbe diventare il miglior
ordine del proprio lato.
Cosa fa: arretra di un tick dietro il miglior ordine altrui. Se arretrare
uscirebbe dalla fascia premiante, si ferma al bordo della fascia e dichiara che
si trova in cima.
Cosa NON fa: non resta mai primo per scelta. Essere primi significa incassare
tutto il flusso aggressivo, cioè essere eseguiti proprio quando il prezzo sta per
muoversi contro. Quando «un tick dietro il migliore» e «dentro la fascia» si
contraddicono, vince la fascia.
Nota: il bot sottrae i PROPRI ordini dal libro prima di guardare chi c'è davanti,
altrimenti inseguirebbe se stesso fino al bordo.

A6 · IL MERCATO È QUASI RISOLTO
Quando: il prezzo è sotto 3 centesimi o sopra 97.
Cosa fa: non quota.
Cosa NON fa: non prova a spremere gli ultimi centesimi di premio da un mercato
che sta per chiudersi.
Se il dato non è leggibile: una soglia configurata male viene ignorata in favore
del difetto — una configurazione sbagliata non può spegnere una protezione.

────────────────────────────────────────────────────────────────────────────────
B · MENTRE GLI ORDINI SONO A LIBRO
────────────────────────────────────────────────────────────────────────────────

B1 · IL PREZZO MEDIO SI MUOVE E L'ORDINE ESCE DALLA FASCIA
Quando: la distanza fra l'ordine e il prezzo medio supera il raggio della fascia
premiante.
Cosa fa: sposta l'ordine dentro la fascia, ma solo dopo che l'uscita è stata
confermata da due osservazioni consecutive, e non prima che siano passati 30
secondi dall'ultimo spostamento dello stesso ordine.
Cosa NON fa: non insegue ogni oscillazione. Un prezzo medio nervoso produrrebbe
un ordine che si muove in continuazione, e ogni movimento costa la posizione in
coda — cioè il diritto di essere eseguiti dopo gli altri, che per questo bot è un
vantaggio.
Se il dato non è leggibile: prezzo medio vecchio o di seconda mano ⇒ non si tocca
niente. È il rifiuto più importante di tutto il motore: muovere un ordine reale
sulla base di un numero che non descrive più il libro è il modo peggiore di
sbagliare.

B2 · SIAMO DIVENTATI I PRIMI DEL NOSTRO LATO SENZA CHE IL PREZZO SI MUOVESSE
Quando: un concorrente si ritira e il nostro ordine diventa il migliore, mentre
il prezzo medio è fermo.
Cosa fa: si rimette un tick dietro al nuovo miglior ordine altrui. Se spostarsi
uscirebbe dalla fascia, cancella senza rimpiazzo.
Cosa NON fa: non resta in cima nemmeno per continuare a essere premiato.
Se il dato non è leggibile: profondità del libro non leggibile ⇒ non fa niente e
lo dichiara.
Nota: vale solo per gli ordini di acquisto. Un ordine di vendita è un'uscita, e
arretrare un'uscita è il contrario di uscire.

B3 · LA PROFONDITÀ DAVANTI SI ERODE, MA QUALCUNO RESTA ANCORA DAVANTI
Quando: la quantità di ordini altrui fra il nostro prezzo e il prezzo medio
scende sotto il 40% della sua media recente su quel mercato e quel lato, per due
letture consecutive, e il prezzo medio non si è mosso.
Cosa fa: CANCELLA l'ordine e resta fuori dal libro. Rientra appena la profondità
risale sopra il 60% della media congelata al momento dell'uscita, e comunque
dopo al massimo cinque minuti — in quel caso dichiara che è rientrato per
scadenza del tetto, non perché il libro si sia ricostruito. Fra due uscite sullo
stesso mercato e lato passa almeno un minuto.
Cosa NON fa: non produce mai un prezzo. Questo meccanismo può solo cancellare;
non sceglie dove rimettere l'ordine, non allarga nessun limite, non tocca la
fascia né la regola di non essere primi.
Se il dato non è leggibile: profondità non leggibile ⇒ la serie di misure non
avanza e nessun giudizio cambia. Se il registro delle uscite non è scrivibile,
NON si cancella: meglio non uscire che uscire e rientrare subito, perché la
seconda cosa paga il costo (l'ordine perde la posizione in coda) senza comprare
la protezione.
Nota: il registro delle uscite è su disco perché a cancellare è un processo e a
rimettere l'ordine a libro è un altro. Se quel registro non è leggibile, non
esiste nessuna sospensione e la gamba torna a libro: una sospensione è una
rinuncia al premio, e un file che non si legge non deve poter tenere il bot fuori
dal mercato per sempre.

B4 · LA MEDIA DI RIFERIMENTO NON È ANCORA FORMATA
Quando: il bot è appena partito, o ha appena riprezzato quell'ordine.
Cosa fa: niente. Servono almeno cinque letture distribuite su almeno due minuti
prima che esista una media, e senza media non si afferma nulla.
Cosa NON fa: non tratta «non ho ancora abbastanza storia» come «va tutto bene» né
come il suo contrario.
Nota: un ordine piazzato esattamente sul tocco ha per costruzione zero profondità
davanti, quindi la media resta zero e questo meccanismo non scatta mai su di lui.
È voluto.

B5 · IL LIBRO NON SI VEDE PIÙ DA TROPPO TEMPO
Quando: sono passati più di 120 secondi dall'ultima lettura buona del prezzo di
quel mercato.
Cosa fa: cancella l'ordine.
Se il dato non è leggibile: l'orologio della cecità si azzera SOLO su una lettura
buona. Una cancellazione fallita non lo azzera.

B6 · L'ORDINE STA PER SCADERE
Quando: la scadenza nativa dell'ordine presso il venue si avvicina.
Cosa fa: lo rinnova con un ordine nuovo e una finestra piena.
Cosa NON fa: non lo lascia morire lasciando il libro vuoto. Se però il rinnovo
non passerebbe i controlli — per esempio perché il prezzo non sarebbe più valido
— non rinnova, e lo dichiara.

B7 · UNA GAMBA È SPARITA E L'ALTRA È RIMASTA
Quando: al venue risulta un solo ordine dei due, e non c'è stata nessuna
esecuzione.
Cosa fa: rimette a libro la gamba mancante, ricalcolando la quantità per
ENTRAMBE in modo che tornino uguali. La gamba sopravvissuta può solo essere
ridotta, mai ingrandita. Se ridurla fallisce, non piazza la nuova: due gambe di
quantità diversa sono peggio di una sola, perché la seconda non è né premiante né
chiudibile.
Cosa NON fa: non ricostruisce il piano e non abilita niente. Se il mercato non è
più nel piano salvato, lo dichiara e passa oltre.
Se il dato non è leggibile: se i due token non si leggono, non si tenta. Se le
due letture (quale gamba manca, quali ordini sono vivi) non concordano, una delle
due è vecchia e non si fa niente.
Nota: c'è un raffreddamento crescente — subito, poi 5, 10, 20 minuti, con un
tetto di 30 — perché il ciclo che ospita questa decisione gira ogni due minuti, e
senza raffreddamento un mercato che rifiuta sempre verrebbe ritentato 720 volte
al giorno.

B9 · IL BOT STA PER RIMETTERE A LIBRO UNA GAMBA CHE HA APPENA TOLTO
Quando: la gamba è stata cancellata perché la profondità davanti si era erosa (caso B3), e il
meccanismo che rimette a libro le gambe mancanti gira di lì a poco.
Cosa fa: non la rimette. Legge il registro delle uscite e aspetta che la sospensione scada o che la
profondità torni.
Cosa NON fa: non aggira il registro. Senza quel controllo l'uscita da cinque minuti durerebbe due — il
meccanismo che ripristina le gambe parte SUBITO, perché la scadenza degli ordini è di ventitré minuti —
e il giornale mostrerebbe una cancellazione e un ripristino, cioè quello che il bot fa già: la regola
sarebbe invisibile oltre che inerte.
Se il dato non è leggibile: registro illeggibile ⇒ nessuna sospensione ⇒ la gamba torna a libro. È il
verso opposto della regola generale, e ha una ragione: una sospensione è una rinuncia al premio, e un
file che non si legge non deve poter tenere il bot fuori dal mercato per sempre.

B8 · IL MERCATO USCITO DALL'ELENCO HA ANCORA I NOSTRI ORDINI
Quando: la selezione toglie un mercato mentre lì ci sono ancora ordini o
posizioni.
Cosa fa: smette di aprire su quel mercato, ma continua a gestirlo: riprezzo,
rinnovo, uscita automatica e chiusura forzata restano attivi.
Cosa NON fa: non lo abbandona. Il perimetro di ciò che il bot può toccare è
sempre «i mercati scelti PIÙ quelli dove c'è già capitale esposto», mai solo i
primi.

────────────────────────────────────────────────────────────────────────────────
C · QUANDO UN ORDINE VIENE ESEGUITO
────────────────────────────────────────────────────────────────────────────────

C0 · PRIMA DI TUTTO: LA COPPIA È GIÀ COMPLETA
Quando: sul mercato ci sono SI e NO nella stessa quantità.
Cosa fa: fonde, subito, sempre. Non guarda nessun prezzo, nemmeno il prezzo di
carico.
Cosa NON fa: non vende una delle due gambe sul libro. Venderla attraverserebbe
due spread per riprendersi qualcosa che si ha già, mentre la fusione rende un
dollaro per share immediatamente e senza slippage.
Se il dato non è leggibile: anche se il prezzo di carico non è leggibile, si
fonde lo stesso — per fondere una coppia completa il carico non serve a niente.

C1 · FILL TOTALE, E L'ALTRO LATO È ABBASTANZA ECONOMICO
Quando: un ordine è stato eseguito per intero e il prezzo di vendita dell'altro
lato, sommato al nostro carico, sta sotto 101 centesimi.
Cosa fa: compra l'altro lato immediatamente, attraversando il libro, per tutta la
quantità che il libro offre entro quel tetto. Se il libro ne copre solo una parte,
compra quella e il resto passa al caso successivo: mezza coppia a prezzo giusto
vale più di una coppia intera a prezzo sbagliato.
Se il dato non è leggibile: se la scala dei prezzi di vendita dell'altro lato non
è disponibile, questo caso non è valutabile e si passa al successivo, dichiarando
che non è stato scartato per prezzo ma per assenza di dati.

C2 · FILL TOTALE, MA L'ALTRO LATO COSTA TROPPO
Quando: comprare subito porterebbe la coppia sopra 101 centesimi.
Cosa fa: mette un ordine di acquisto FERMO sull'altro lato, al prezzo massimo che
rispetta il tetto, e se quel prezzo cade sopra il bordo della fascia premiante lo
abbassa fino al bordo — così l'ordine matura premio mentre aspetta, invece di
essere capitale fermo. Aspetta 30 minuti.
Cosa NON fa: non sostituisce l'ordine vivo quando ai cicli successivi deve
aumentarne la quantità: AGGIUNGE la differenza. Sostituirlo aprirebbe una
finestra in cui la posizione è completamente scoperta.
Se il dato non è leggibile: se la quantità già a riposo non è leggibile, non
aggiunge niente al buio.

C3 · SONO PASSATI 30 MINUTI E LA COPPIA NON SI È CHIUSA
Quando: l'ordine fermo di completamento è lì da mezz'ora.
Cosa fa: lo cancella e passa all'uscita classica, cioè vendere la posizione.
Nota: questo controllo viene fatto PRIMA di riproporre l'ordine fermo, altrimenti
l'attesa si rinnoverebbe da sola a ogni giro e il tempo non scadrebbe mai.

C4 · FILL PARZIALE
Quando: un ordine è stato eseguito solo in parte.
Cosa fa: due cose. Compra l'altro lato per la quantità ESATTA che è stata
eseguita. E cancella la parte residua dell'ordine, sempre, a ogni giro finché è
lì — non solo la prima volta, e anche se è sotto la quantità minima.
Cosa NON fa: non lascia il residuo a libro sperando che si riempia da solo. Si
perde la possibilità che la coppia si completi senza pagare lo spread, e si evita
una posizione direzionale che cresce mentre la scala d'uscita la riduce.

C5 · LA POSIZIONE È SCOPERTA DA UN PO'
Quando: c'è una gamba senza la sorella, e il tempo passa.
Cosa fa: una scala di concessioni crescenti.
· fino a 30 minuti: niente di nuovo, si prova a chiudere in guadagno;
· da 30 minuti: l'uscita può scendere fino al prezzo di carico, cioè in pareggio;
· da 60 minuti: l'uscita può scendere fino al 5% sotto il carico;
· da 4 ore: come sopra, più un'anomalia grave registrata. Non si apre nessuna
  quarta via: a 60 minuti sono già tutte aperte, e inventarne un'altra
  significherebbe violare un limite di rischio. Qui il bot dichiara di non
  farcela invece di tacere.
Cosa NON fa: non sceglie il prezzo. Produce un PAVIMENTO, cioè il prezzo più
basso accettabile; il prezzo vero lo sceglie il motore, che continua a
inseguire il miglior prezzo d'acquisto disponibile e si ferma al pavimento. La
scala dice quanto si può perdere, il libro dice dove si viene eseguiti, e vince
il più stretto dei due. La concessione non esce mai dalla fascia premiante.
Se il dato non è leggibile: se non si sa da quanto tempo la posizione è scoperta,
nessuna concessione. Non si paga contro un dato che non si è letto.
Nota: sui token molto economici il 5% è meno di un tick, quindi sulla griglia dei
prezzi la concessione si azzera e la gamba resta in attesa invece di essere
svenduta. È il comportamento prudente.

C6 · IL PREZZO D'ACQUISTO CORRENTE PAGA PIÙ DELLA COPPIA
Quando: vendere subito la gamba che abbiamo rende più che comprare l'altro lato e
fondere.
Cosa fa: vende, attraversando il libro, tutta la quantità in una volta.
Cosa NON fa: non vende una parte. Una copertura parziale lascerebbe un residuo
sotto la quantità minima, cioè capitale senza via d'uscita. E non si limita a
stare al miglior prezzo d'acquisto: lo attraversa, perché restare sopra
significherebbe non essere eseguiti.
Se il dato non è leggibile: se il prezzo di vendita dell'altro lato, la scala dei
prezzi d'acquisto o il carico non sono leggibili, non scatta.
Nota importante: il criterio non ha costanti arbitrarie. Incassare al prezzo
d'acquisto conviene esattamente quando il prezzo d'acquisto di un lato più il
prezzo di vendita dell'altro superano un dollaro. Il margine richiesto è un
centesimo per share.

C7 · IL RESIDUO È SOTTO LA QUANTITÀ MINIMA DEL VENUE
Quando: resta una posizione troppo piccola perché il venue accetti un ordine.
Cosa fa: la vende comunque, attraversando il libro. La quantità minima è quella
del programma PREMI, non un rifiuto del venue: dice «questo ordine non maturerà
nulla», non «questo ordine sarà respinto». Su una vendita che chiude, il premio
non è lo scopo e il capitale si libera.
Se vendere non è possibile — prezzo d'acquisto non leggibile, o ricavo nullo —
prova la via che non passa dal libro: comprare l'altro lato per la stessa
quantità e fondere. Può farlo anche se la coppia costerà più di un dollaro, ma
non spende più di quanto la posizione valga, e mai più di 5 dollari. Compra tutto
o niente: comprare metà lascerebbe un residuo su ENTRAMBI i lati, cioè due
posizioni bloccate invece di una.
Cosa NON fa: se nessuna delle due vie sta dentro i limiti, non fa niente e
dichiara quanto sarebbe servito. Si aspetta la risoluzione del mercato, dove la
posizione varrà zero o uno per share. Il costo dell'attesa è il tempo, non il
capitale.
Se il dato non è leggibile: se il prezzo corrente della posizione non è
leggibile, non si compra al buio — senza il suo valore non si sa quanto si può
spendere. Se la scala dei prezzi dell'altro lato non è disponibile, non si
presume né buona né cattiva: non si compra.

C8 · LA POSIZIONE È APERTA DA PIÙ DI UN'ORA E NESSUNO L'HA CHIUSA
Quando: la scala d'uscita ha attraversato tutti i suoi gradini senza risultato.
Cosa fa: vende attraversando il libro, accettando il prezzo che trova. È l'ultima
rete, ed è deliberatamente stupida: non conosce gradini né modalità, guarda una
cosa sola — da quanto tempo esiste questa posizione — e oltre la soglia dice
«chiudila».
Cosa NON fa: non tocca le coppie complete (valgono un dollaro per share alla
risoluzione: liquidarle attraverserebbe due spread per non recuperare niente) né
le posizioni più giovani della soglia. Non apre niente, non riabilita mercati,
non tocca gli interruttori.
Quando gira: SEMPRE, anche a bot fermo. Chiudere una posizione aperta è gestione,
non apertura, e lo stato in cui le gambe scoperte sono più probabili — subito
dopo un blocco d'emergenza — è esattamente quello in cui devono essere guardate.
L'unica cosa che lo ferma è il blocco d'emergenza generale.
Se il dato non è leggibile: posizioni non leggibili ⇒ non fa niente, e non
azzera i propri contatori di anzianità: azzerarli significherebbe che ogni
singhiozzo della lettura regala un'altra ora a una posizione vecchia.
Nota: al primo avvio le posizioni già aperte partono da adesso. Non c'è modo di
sapere quando sono nate senza fidarsi di uno stato che questo meccanismo esiste
per non dover consultare. Conseguenza: dopo un riavvio concede una soglia intera
prima di agire.

C9 · L'ULTIMA RETE È INTERVENUTA
Quando: è il caso C8.
Cosa fa: oltre a chiudere, registra che la scala d'uscita NON ha funzionato.
L'intervento di questo presidio è di per sé un'anomalia da guardare, e viene
scritto come tale invece di essere dedotto confrontando due registri.

────────────────────────────────────────────────────────────────────────────────
D · MERCATO E TEMPO
────────────────────────────────────────────────────────────────────────────────

D1 · IL MERCATO SI AVVICINA ALLA RISOLUZIONE
Quando: mancano meno di tre ore.
Cosa fa: forza la chiusura delle posizioni direzionali, dopo aver cancellato gli
ordini.
Cosa NON fa: non forza la chiusura di una coppia completa. Alla risoluzione vale
un dollaro comunque.
Se il dato non è leggibile: la scadenza si cerca in tre posti — l'elenco dei
mercati premiati, un catalogo di ripiego e il venue stesso. Se le fonti divergono
di più di 24 ore, il mercato viene escluso a monte. Se una fonte manca
semplicemente, non esclude: le due direzioni di fallimento sono opposte apposta.

D2 · UN MERCATO NUOVO RENDE MOLTO PIÙ DI UNO CHE ABBIAMO
Quando: la differenza di rendimento netto supera 50 centesimi al giorno oppure il
25%, e l'occupante non ha ordini a riposo né una posizione aperta.
Cosa fa: toglie il vecchio e mette il nuovo, purché appartenga allo stesso
scaglione di composizione.
Cosa NON fa: non sostituisce per un pelo. Senza quel margine due mercati con
rendimenti quasi uguali si scambierebbero il posto a ogni ciclo, e ogni scambio
costa un giro di cancellazioni e ripiazzamenti.
Se il dato non è leggibile: se il rendimento di uno dei due non è noto, non si
sostituisce — non si può dimostrare che lo scambio migliori. Se l'elenco degli
ordini vivi non è leggibile, si assume che l'occupante ne abbia e non si
sostituisce nessuno: «non ho guardato» non può autorizzare a cancellare ordini
altrui.

D3 · UN MERCATO RICEVE UN'ESECUZIONE
Quando: succede un fill, totale o parziale.
Cosa fa: quel mercato esce dal conteggio dei mercati attivi e ne entra uno nuovo,
mentre lui resta gestito fino a coppia chiusa.
Conseguenza da sapere: l'esposizione totale NON è più limitata al numero di
mercati attivi. Tre quotano mentre altri completano. Ciò che la limita sono, in
ordine: il tetto per mercato (61,25 dollari), il tetto sull'esposizione aperta
(150 dollari, che conta le esecuzioni riconciliate e non gli ordini a riposo) e
il kill sulla perdita giornaliera (100 dollari).

D4 · IL MERCATO SCADE MENTRE LO ABBIAMO
Quando: la scadenza scende sotto il minimo.
Cosa fa: lo toglie dall'elenco degli attivi anche nei giri in cui nessun altro
meccanismo scatta.
Cosa NON fa: non spegne la gestione. Uscire dall'elenco spegne l'ingresso, non
l'uscita.

────────────────────────────────────────────────────────────────────────────────
E · GUASTI, PERDITE, EMERGENZE
────────────────────────────────────────────────────────────────────────────────

E1 · IL CAPITALE PERDE VALORE
Quando: il totale (liquidità più posizioni al prezzo corrente) scende del 5%, o
di una soglia in dollari derivata, sotto il massimo storico raggiunto.
Cosa fa: cancella TUTTI gli ordini a riposo su ogni mercato, deposita un referto
e mette il bot su fermo. Serve la conferma di due letture consecutive e contigue:
oltre 120 secondi fra una lettura e l'altra il contatore riparte.
Cosa NON fa: non tocca le posizioni aperte e non ferma l'uscita automatica. È una
decisione: questa misura riguarda un PREZZO, che può rientrare, e liquidare su un
prezzo che rientra trasforma una perdita di carta in una perdita vera.
Se il dato non è leggibile: una lettura non calcolabile azzera il contatore delle
conferme — «non ho letto» non può confermare che la perdita persisteva.
Nota: depositi e prelievi sono riconosciuti come movimenti di cassa, non come
perdite o guadagni.

E2 · LA PERDITA REALIZZATA NELLA GIORNATA RAGGIUNGE 100 DOLLARI
Quando: il registro delle esecuzioni dice che oggi si è perso più di quella
soglia.
Cosa fa: la stessa cancellazione totale e lo stesso fermo del caso precedente, E
IN PIÙ chiede la chiusura delle posizioni. Le coppie complete vanno fuse, le
gambe scoperte sopra la quantità minima vendute attraversando il libro, quelle
sotto la quantità minima restano e vengono dichiarate.
Come lo fa: chi decide non esegue e chi esegue non decide. Il processo che
sorveglia le perdite classifica le posizioni e deposita una richiesta; la sua
unica capacità di agire sul venue resta la cancellazione. A vendere è un altro
processo, che gira anche a bot fermo. La separazione è il presidio, non un
ripiego.
Cosa NON fa: non fonde da sé. La fusione ha un percorso solo, e una seconda
strada verso di essa sarebbe una seconda verità su cosa si firma.
Se il dato non è leggibile: se la perdita non è leggibile NON si cancella. Qui la
direzione è opposta a quella del gate di piazzamento — che invece rifiuta — ed è
coerente: rifiutare è non-agire ed è gratis, cancellare è agire e distruggerebbe
premi veri per un'ignoranza nostra. Se le posizioni non sono leggibili, nessuna
classificazione e nessuna azione: «non ho letto» non è «non c'è niente». Se la
quantità minima di un mercato non è nota, la gamba si LASCIA invece di venderla.
Nota: qui il comportamento sui residui sotto il minimo è diverso da quello
ordinario, ed è voluto. La regola ordinaria vale dove c'è tempo per un'uscita
attraversata; l'emergenza dà priorità a togliere l'esposizione grande in fretta,
senza aprire percorsi nuovi nel momento peggiore. E la differenza è minore di
quanto sembri: dopo il kill il bot è fermo, non bloccato, quindi l'ultima rete
continua a girare e chiuderà comunque quei residui al giro dopo la loro soglia.

E3 · IL BLOCCO D'EMERGENZA GENERALE È ATTIVO
Quando: qualcuno lo ha inserito, o non è leggibile.
Cosa fa: nessun percorso piazza, e nemmeno l'uscita automatica funziona.
Cosa NON fa: non è l'interruttore operativo. Inserirlo lascia le posizioni aperte
SENZA via d'uscita, ed è per questo che esiste un interruttore separato per
«smetti di aprire».
Se il dato non è leggibile: si comporta come se fosse attivo.

E3-bis · IL BOT È SU «FERMO» — cosa continua a girare, e cosa no
Quando: l'interruttore operativo è su fermo, per mano di una persona o perché un kill lo ha messo lì.
Cosa fa: smette di APRIRE. Non sceglie mercati nuovi, non alloca capitale, non rimette a libro gambe
mancanti.
Cosa CONTINUA a fare: tutto quello che TOGLIE esposizione. L'uscita automatica, la riprezzatura e il
rinnovo delle posizioni aperte, la chiusura di sicurezza dopo un'ora, e la chiusura d'emergenza
richiesta da un kill.
Perché conta: lo stato in cui le gambe scoperte sono più probabili — subito dopo un kill — è
esattamente quello in cui devono essere guardate. Un fermo che spegnesse anche l'uscita lascerebbe le
posizioni senza nessuno che se ne occupa, ed è precisamente ciò che il blocco d'emergenza generale fa
apposta e questo interruttore non deve fare.

E4 · IL BOT SMETTE DI LAVORARE SENZA CHE NESSUNO SE NE ACCORGA
Quando: gli ordini a riposo sono zero, o il capitale al lavoro sta sotto il 50%
per quindici minuti, o non c'è stato nessun ciclo negli ultimi venti minuti, o
troppi rinnovi dovuti non sono partiti.
Cosa fa: una scala di rimedi, un gradino ogni cinque minuti: ricostruisce il
piano, ricarica la configurazione, riconcilia l'esposizione, ripara le
precondizioni, risveglia il feed dei prezzi, e infine si ferma in sicurezza. Caso
peggiore: fermo in circa mezz'ora.
Cosa NON fa: nessun gradino tocca un limite di rischio, per costruzione.
Se il dato non è leggibile: se le misure non sono leggibili non si giudica, e la
scala non parte affatto.
Nota: l'ultimo gradino è disarmato per decisione dell'operatore. Disarmato non
vuol dire assente: la scala sale comunque fino in fondo e il gradino registra che
sarebbe scattato e perché.

E5 · LO STESSO RIFIUTO SI RIPETE ALL'INFINITO
Quando: cinque rifiuti identici di fila sulla stessa coppia mercato-motivo.
Cosa fa: dipende dalla famiglia del rifiuto. Se è un limite di rischio, nessuna
azione: si cambia mercato e si dichiara perché. Se è uno stato interno del bot,
si cerca una via alternativa vera. Se è transitorio, non è un blocco.
Se la famiglia non è riconosciuta: si tratta come un limite di rischio, cioè non
si aggira.

E6 · UNA POSIZIONE COMPARE SENZA CHE NOI ABBIAMO PIAZZATO NIENTE
Quando: al venue risulta una posizione che nessun nostro ordine giustifica.
Cosa fa: allarme dichiarato.
Cosa NON fa: non la adotta e non la gestisce come se fosse sua.

E7 · UN MERCATO RIFIUTA I NOSTRI ORDINI PER UNA RAGIONE STRUTTURALE
Quando: il venue rifiuta ripetutamente lo stesso mercato.
Cosa fa: lo mette in quarantena per venti minuti, così l'esito sopravvive al
ciclo e il ricalcolo del piano non lo ripesca subito.
Cosa NON fa: la quarantena non è un lasciapassare al contrario. Un mercato in
quarantena che arrivasse comunque al piazzamento sarebbe giudicato da tutti i
controlli come prima.

E8 · UN ORDINE PARTE MA NON SI SA SE È ARRIVATO
Quando: la richiesta è partita e la risposta è ambigua.
Cosa fa: interroga il venue. Se l'ordine c'è, l'esito è «riuscito». Se la
verifica non riesce, NON ritenta: fra due ordini e zero ordini, il secondo errore
costa meno.

E9 · IL VENUE CI RALLENTA
Quando: il venue risponde «troppe richieste».
Cosa fa: aspetta un secondo, poi due, poi quattro; se il venue dice esplicitamente
quanto aspettare, quella indicazione vince su qualunque progressione. Le letture
delle posizioni riprovano fino a cinque volte con attese crescenti e una
variazione casuale, perché senza quella variazione tutti i lettori ripartirebbero
nello stesso istante e il rallentamento diventerebbe permanente.
Cosa NON fa: le quotazioni ordinarie non riprovano — un ordine di liquidità può
aspettare il ciclo dopo. Le sei chiusure invece riprovano fino a tre volte, ma
solo se a rifiutare è stato il venue: se a rifiutare è un nostro controllo,
ritentare significherebbe martellare il proprio codice.

E10 · IL RIPREZZO CANCELLA MA NON RIESCE A RIPIAZZARE
Quando: si sta sostituendo un ordine.
Cosa fa: cinque controlli PRIMA di cancellare. Se uno solo non passa, l'ordine
resta dov'è e il ciclo successivo riprova.
Cosa NON fa: non cancella mai ciò che non può rimpiazzare.

════════════════════════════════════════════════════════════════════════════════
PARTE TERZA — I NUMERI IN SERVIZIO
════════════════════════════════════════════════════════════════════════════════

Capitale massimo per mercato .................. 61,25 dollari
Soglia premiante massima accettata ............ 50 share
Scadenza minima per entrare ................... 24 ore
Mercati contemporanei ......................... 3 (uno, due o tre; decide l'operatore)
Composizione a tre mercati .................... 1 basso + 2 alti = 147 dollari
Prezzo massimo quotabile ...................... 97 centesimi
Prezzi ai quali non si quota .................. sotto 3 e sopra 97 centesimi
Tetto per singolo ordine ...................... 80 dollari
Tetto sull'esposizione aperta ................. 150 dollari
Perdita giornaliera che ferma tutto ........... 100 dollari
Perdita percentuale che cancella tutto ........ 5% dal massimo storico
Costo massimo della coppia .................... 101 centesimi
Attesa dell'ordine di completamento ........... 30 minuti
Scala d'uscita ................................ 30 min pareggio · 60 min −5% · 240 min anomalia
Erosione: soglia d'uscita ..................... sotto il 40% della media recente
Erosione: soglia di rientro ................... sopra il 60%
Erosione: tempo massimo fuori dal libro ....... 5 minuti
Erosione: attesa fra due uscite ............... 60 secondi
Sblocco di un residuo: spesa massima .......... il valore della posizione, e mai oltre 5 dollari
Chiusura forzata prima della risoluzione ...... 3 ore
Chiusura di sicurezza di una posizione ........ 60 minuti
Intervallo minimo fra due riprezzi ............ 30 secondi
Conferme richieste per riprezzare ............. 2 letture consecutive
Cecità sul prezzo che fa cancellare ........... 120 secondi
Mercati nuovi per giro ........................ 10
Margine per sostituire un mercato ............. 0,50 dollari al giorno oppure 25%

════════════════════════════════════════════════════════════════════════════════
PARTE QUARTA — I PRINCIPI CHE SPIEGANO TUTTO IL RESTO
════════════════════════════════════════════════════════════════════════════════

1. NON HO LETTO NON È NON C'È. È il difetto più ricorrente in questo sistema, e
   ha prodotto guasti veri più di ogni altra causa. Un dato mancante non diventa
   mai zero, mai «va bene», mai «va male». Ogni volta che manca, il bot sceglie
   esplicitamente una direzione e la dichiara.

2. LA DIREZIONE PRUDENTE NON È SEMPRE LA STESSA. Rifiutare di piazzare su un
   dato mancante è gratis, quindi si rifiuta. Cancellare tutti gli ordini su un
   dato mancante distruggerebbe premi veri, quindi non si cancella. Tenere il bot
   fuori dal libro su un file illeggibile lo terrebbe fuori per sempre, quindi si
   rientra. Le tre direzioni sono diverse e coerenti con lo stesso principio: non
   agire al buio, dove «agire» è ogni volta una cosa diversa.

3. OGNI DIFESA AGISCE, NON SEGNALA SOLTANTO. Non c'è nessuno a leggere i log in
   tempo reale. Una difesa che scrive «attenzione» e non fa niente non è una
   difesa. La metà opposta vale altrettanto: quando l'unica via d'uscita
   violerebbe un limite di rischio, il bot non agisce e lo dichiara.

4. CHI DECIDE NON ESEGUE. Le decisioni pericolose sono scritte in moduli che non
   possono toccare il venue — nessuna rete, nessuna firma, nessun ordine. Chi
   esegue non decide. La separazione è il presidio, non un'eleganza.

5. UN NUMERO VIVE IN UN POSTO SOLO. Due copie dello stesso limite divergono, e
   quando divergono nessuno se ne accorge finché non costa. Ogni costante ha un
   proprietario, e chi la usa la importa.

6. UN COMMENTO CHE INVECCHIA DECIDE. Più volte in questo sistema una protezione è
   rimasta al suo posto per anni perché un commento diceva che serviva, mentre il
   motivo era decaduto. Quando cambia il comportamento, cambia anche ciò che è
   scritto accanto.

7. UNA PROVA CHE NON SA CADERE NON È UNA PROVA. Ogni verifica di questo sistema è
   stata fatta cadere di proposito almeno una volta, sul codice precedente, per
   dimostrare che stava misurando qualcosa.

8. UNA PROVA CHE DIPENDE DALLO STATO DEL BOT NON MISURA IL BOT. Se una verifica
   legge il piano, la selezione, le posizioni o il registro VIVI, il suo esito
   dice cosa stava facendo il bot quando è stata lanciata, non se il codice è
   giusto. Il caso peggiore non è il rosso: è il verde che arriva da solo il
   giorno in cui lo stato per caso combacia, perché quel verde non significa
   niente. Ogni verifica riceve i dati su cui deve giudicare — non li cerca.

9. QUANDO UNA REGOLA CAMBIA, LA SUA PROVA VA RISCRITTA, NON AMMORBIDITA. Una
   verifica che difende la regola vecchia è indistinguibile da una che ha trovato
   un difetto: le si toglie la vecchia proprietà e le si dà la nuova, sullo
   stesso caso e con la stessa severità. Ammorbidirla — allargare una soglia,
   togliere un'asserzione — trasforma una decisione in una dimenticanza.

10. IL PREMIO SI MATURA STANDO FERMI. Ogni movimento costa la posizione in coda.
   Per questo quasi tutte le tarature sono orientate al NON agire: soglie con
   isteresi, conferme multiple, intervalli minimi, raffreddamenti crescenti. Un
   bot nervoso su questo venue perde il montepremi per evitare due esecuzioni
   sfortunate.

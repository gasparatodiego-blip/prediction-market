# Registro delle voci chiuse (§5-bis) — archivio

> Estratto da `CLAUDE.md` il 22 agosto 2026 nella potatura sotto i 120k.
> Contiene §5-bis per intero: le 205 voci chiuse, il registro 1-119 e la tabella delle classi di difetto.
> **Il testo qui sotto è VERBATIM: niente è stato riscritto né cancellato.**

---

## 5-bis · REGISTRO DELLE VOCI CHIUSE

**A cosa serve.** Le decisioni vive stanno in §4; qui resta la **mappa**, perché un riferimento come
«§5 punto 72» sparso nei commenti del codice deve restare risolvibile, e perché sapere *che* un
problema è già stato incontrato vale più del racconto di come. Il dettaglio integrale è in `git log`
e nei commit citati nei sorgenti.

**153** · IL GRADINO 6 NON ESISTEVA: `impostaBot` NON ERA IMPORTATO

**205** · DA 5 A 10 MERCATI E IL CAP A $1.300 — 22 agosto 2026, decisione dell'operatore.
Tre valori e nient'altro: `selezione-mercati.MAX_MERCATI_CONTEMPORANEI` 5 → **10** (il letterale unico,
da cui `quanti-mercati` deriva difetto e massimo e `quotaScaglioni` deriva la composizione),
`MAKER_MERCATI_CONTEMPORANEI` '5' → **'10'** su agent41, `maxOpenNotionalUsd` $650 → **$1.300**.
**IL PRESUPPOSTO E' p.204**: col guardiano vecchio l'artefatto a 10 mercati a size piena valeva $72,46
contro $75,08 di margine e la coppia del 20/08 **avrebbe fatto scattare**; col nuovo vale **$14,74**
(franco **5,1x**, 9.400 letture reali). ⚠ Il franco NON e' misurabile sulle letture dopo il riavvio di
agent43: 26 letture, **zero posizioni**, artefatto identicamente $0 — finestra degenere, dichiarata.
**⚠⚠ LA SIMULAZIONE A SECCO DAVA ZERO ENTRANTI, E VENTIDUE MINUTI DOPO NE SONO ENTRATI QUATTRO — la
lezione D-A, di nuovo** (§5-bis p.200: «una simulazione a secco su un board vivo scade col board»).
**Alle 04:28Z** (`dieci-mercati-simulazione.js`, funzioni VERE): a N=10 si riempivano **5 slot su 10**,
entranti **0**, premio atteso identico ($0,9509/g lordo, $0,9080/g netto-obiettivo) — non $2,09 → $8,10.
La diagnosi era esatta e vale ancora come **meccanismo**: **230 dei 231 ammissibili** cadevano su
`coda-lunga-senza-fascia-corta` (il board era tutto oltre 7 giorni: 2 soli candidati sotto 168 h,
entrambi a 67 h), e quei 2 cadevano su **`quota-scaglione-piena`** perche' `minSize 20` e il secchio
«basso» ha **UN posto solo a qualunque N**. Senza un attivo di fascia corta la coda non riceve budget
(§4.4), e l'unico modo di averne uno e' il posto che la composizione non concede.
**MA ALLE 04:50:41Z, col tetto a 10 in servizio, la selezione ha applicato `occupati: 9, entrati: 4,
usciti: 0`** — il board si era mosso. Alle 04:52 la lettura VERA del venue dava **14 ordini su 7
mercati, 7 coppie tutte SIMMETRICHE, $375,16 a riposo** (era 10 ordini / 5 mercati / $267,81). A N=5
quei 4 mercati non sarebbero entrati. **Il tetto morde davvero; il numero della simulazione no.**
**⚠ NESSUNA GAMBA ESISTENTE E' STATA TOCCATA, E LA SIZE NON E' CAMBIATA**:
`unitUsd = min(round(budget/50), floor(tetto/8)) = $7` a **entrambi** i budget, quindi la riga massima
resta `8 x $7 = $56` (91,4% del tetto) e la size resta **56,5 share**. «Size al tetto pieno» (62,5
share) **non e' raggiungibile** senza toccare `LIVELLI_MINIMI_PER_MERCATO` (§4.3, la difesa del deadlock
del 13 agosto), che non e' stato toccato — quindi le 10 gambe gia' a libro non sono state ne' cancellate
ne' ridimensionate, e **zero premio maturato e' andato perso**. Le uniche scritture al venue dopo il
riavvio sono i rinnovi GTD di agent40 e le coppie NUOVE dei mercati entrati.
**⚠ LA CASSA NON E' IL VINCOLO**: $1.225 e' cio' che il GATE somma, non i dollari che escono — un BUY a
riposo non abbassa il saldo (§4.5). Esborso peggiore a coppie tutte complete **$612,50** ⇒ cassa residua
**$882,28 (59,0%)**, non il 18%.
**⚠ IL NUMERO SCOMODO, misurato e non modellato**: equity $1.499,64 (15/08) → $1.494,78 = **−$4,86 in
6,65 giorni**; reward VERI incassati nello stesso arco **$7,13** (`data/confronto-reward.json`,
`realeUsd`) ⇒ trading **−$11,99**, cioe' **1,68x il premio**, netto **−$0,73/giorno**. La configurazione
e' netta NEGATIVA, e a slot pieni scalerebbe con l'esposizione.
**⚠ QUOTA DEL LIBRO**: su 231 ammissibili a $56 di riga, **zero** superano il 50% e **zero** il 25%; la
piu' alta e' **7,24%**. Il tetto di credibilita' 0,60 non morde a questa size.
⚠ `selezione-mercati.test.js` blocco 5 e' stato **RISCRITTO e non ammorbidito**: asseriva «mai due
mercati ATTIVI della stessa categoria», proprieta' che il modulo **non promette piu'** dal 15 agosto
(§4.13) e che passava per **pigeonhole** (fixture a 8 categorie, soffitto 5). A soffitto 10 su 8
categorie la ripetizione e' aritmetica. Ora difende cio' che il modulo promette: la categoria c'e'
sempre. Suite dopo il commit: **245 test · 237 verdi · 7 rossi noti · 1 non parte** — gli **stessi 7 nomi**
della baseline delle 03:32 (`suite-rossi-baseline.json`), nessuno introdotto.

**204** · §5.2 p.54 · LE DUE FONTI DEL TOTALE NON ERANO CO-TEMPORALI: SI RICONCILIANO SUL VALORE, NON
SUI TIMESTAMP — 22 agosto. Regola per intero in §3 (scheda del guardiano).
**IL FATTO, RICOSTRUITO AL CENTESIMO DALLE COMPONENTI VERE**: la lettura che ha fatto scattare il
guardiano il **20/08 22:36:02** ($1.438,41 ⇒ libro cancellato, bot su FERMA, **6h06m di fermo**) e'
`saldo(22:30) $1.402,98 + posizioni(22:26) $35,42 = $1.438,40` — **241 secondi di scarto**. L'equity
vera non si e' mai mossa da $1.491-1.495. Altre due letture della stessa serata si ricostruiscono uguale,
una per verso: `22:30:58 = saldo(22:30)+pos(22:31) = $1.472,00` e `22:34:31 = saldo(22:35)+pos(22:34) =
$1.513,25` — quest'ultima **sopra** il riferimento, cioe' lo stesso difetto di D-D (§5-bis p.202).
**⚠ LA TOLLERANZA SUI TIMESTAMP E' STATA MISURATA E SCARTATA**, ed e' la cura che viene in mente per
prima: su 9.324 campioni le 11 letture contaminate hanno un'eta' dichiarata dello snapshot fra **749 ms
e 52 s**, cioe' sovrapposte alle pulite; a 5 s si rifiuterebbe l'**87%** delle letture e ne passerebbero
comunque 2 su 11. La ragione e' strutturale: `writeVenuePositions` timbra `at = now()` alla **SCRITTURA**,
quindi il timestamp non misura la staleness del CONTENUTO. **⚠ E la co-temporalita' vera non e'
raggiungibile**: nessuna delle due fonti si puo' ricampionare a un istante passato.
**LA CURA — `riconciliaFonti`, pura, zero `require`**: un fill non crea ne' distrugge valore, quindi fra
due letture contigue `Δcassa + Δvalore_dovuto_alle_SIZE ≈ 0`; se non vale, **il totale non e' misurabile**.
**⚠⚠ «DOVUTO ALLE SIZE» E' LA META' CHE CONTA**: il valore si muove per size (un fill — e allora la cassa
deve muoversi in modo opposto) e per PREZZO (P&L vero, cassa ferma). Un criterio scritto sul valore
TOTALE accecherebbe il guardiano proprio durante un crollo — misurato: il solo prezzo arriva a **$12,93**
su 4.646 campioni a cassa ferma. Un test dedicato (blocco ③) difende la visibilita' del crollo.
**LA TOLLERANZA VIENE DALLA TABELLA E IL DIVARIO E' VUOTO**: su 29 letture contigue con movimento di
cassa, le 18 compensate hanno residuo **≤ $4,95** e le 11 non compensate **≥ $8,32**. `$6,00` sta nel
vuoto (stessa disciplina dell'85% di p.142).
**⚠ ENTRAMBI I VERSI DA UN CRITERIO SOLO, e non per fortuna**: sia lo scatto sia il cricchetto stanno
dietro `capitale.leggibile`, quindi una lettura rifiutata non scatta **e** non alza il riferimento.
**LA MISURA (9.338 letture vere, 6,60 giorni, funzioni di produzione)**: artefatto massimo **$33,12 →
$6,74** · letture ≥$10 di artefatto **6 → 0** · disponibilita' **99,74%** (24 rifiuti, al piu' **4
consecutivi**) · riferimento finale identico ($1.501,63). **Le tre letture anomale del 20/08 sono tutte
RIFIUTATE.** **LA LEGGE DI SCALA**: il rapporto nuovo/vecchio e' **0,203 a qualunque scala** — a
10 × $61,25 l'artefatto passa da **$72,46 a $14,74** contro un margine di $75,08 (**3,0× di franco**), e
la coppia che fece scattare il guardiano diventa ($16,7 · $25,1) invece di ($82,3 · $123,3). Servirebbe
**k = 9,8**, cioe' ~45 mercati a size piena, per riprodurre quello scatto.
**⚠ NON E' DIVENTATO INERTE, ed e' provato e non promesso**: un controllo positivo guida `poll` VERA su
una perdita di solo prezzo e il guardiano **scatta a k=2, cancella e mette il bot su FERMA** come prima.
**⚠ COSTA UN GIRO DI CECITA' DOPO UN RIAVVIO** (prima lettura senza precedente ⇒ non misurabile, 30 s), e
un guardiano in crash-loop non creerebbe mai il riferimento — dichiarato, non corretto.
**⚠ NON SMETTE DI MISURARE IN SILENZIO**: contatore dei rifiuti consecutivi, riga a ogni giro, riga a
verbale `op:'guardian-riconciliazione'`, e oltre **10 di fila** (5 min, cinque volte il peggio misurato)
il log diventa un allarme. Nessuna AZIONE aggiunta: sarebbe una terza strada autonoma, e non e' chiesta.
**⚠ `riconciliazione` NON HA UN DIFETTO PERMISSIVO**: ometterla vale «non misurabile». agent45 (che
osserva e non decide) dichiara `'non-richiesta'` — e resta lo strumento con cui l'artefatto e' stato
misurato. **⚠ NESSUN ORDINE PUO' ESSERE TOCCATO**: la correzione puo' solo TOGLIERE misure, quindi solo
TOGLIERE scatti; provato con `poll` vera e le superfici che agiscono iniettate in modo da SOLLEVARE.
Prove: `guardian-fonti-co-temporali.test.js` **32/0**, **20 rosse** sul sorgente di ieri. Riscritti e non
ammorbiditi: `guardian-perdite` (70/0), `allarme-guardiano` (23/0), `kill-perdita-giornaliera` (35/0).
Referti: `data/ricerca/p54-replay.md`, `p54-legge-di-scala.json`.

**203** · LA VISTA DEL BOARD DA 150 A 300, E IL COLLO CHE NON ERANO I LIBRI — 21 agosto.
Regola per intero in §4.7. **La misura che ribalta la premessa**: `POST /books` porta **3.112 libri (tutto
l'universo censito) in 2,4 s e 64 MB, 6 mancanti**; un `GET /book` costa **24-152 ms**. Quindi dei
2,74-3,80 s/mercato cronometrati la rete e' il 5-20%: il resto e' `MAX_RPS = 1.5` su una coda
**serializzata**. Il batch toglie 2 delle ~4,1 chiamate accodate per mercato ⇒ **1,40-2,47 s/mercato** ⇒
**300 mercati in 7,0-12,4 min** dentro il periodo; **400 sfora** al ritmo peggiore.
**LA MEMORIA NON E' IL VINCOLO, MISURATA E NON DEDOTTA**: il figlio del piano su board sintetici di
**20/114/300/400/800** righe fatte di mercati veri da' **481/473/487/487/474 MB** di picco (VmHWM) in
40,6-47,1 s — pendenza per candidato **~0**, esattamente come D-C aveva concluso sulla finestra di
giornale (§5-bis p.201). Tetto di heap 952 MB.
**IL DIFETTO CHIUSO PER STRADA**: `measureBookDepth` su `status !== 200` restituiva
`emptyBook:true, Qmin:0` — **concorrenza zero, cioe' la quota stimata MASSIMA**: un mercato di cui NON
avevamo letto il libro si presentava come il migliore del board, e piu' si allarga la vista piu' spesso
sarebbe successo. Ora `analizzaLibro` separa **`assente`** da **`emptyBook`** e il ciclo lo esclude
dichiarandolo; `libri-batch` non ha nessun valore di ripiego da confondere.
⚠⚠ **E IL GUADAGNO PROMESSO NON ARRIVA DA QUESTO CANCELLO** — v. §5.2 p.55: sul board allargato **13 dei
20 migliori per premio atteso hanno concorrenza in banda ZERO**, e sono esattamente i libri di cui
`allocator.js:1133` rifiuta di credere lo zero (`profondita: 'non-verificata'` ⇒ scartato). Simulazione a
secco con le funzioni VERE: premio atteso del piano scelto **$150,36/g a tetto 150 contro $102,09/g a
300** — cioe' col ripiego di ordinamento la vista larga peggiora, perche' si riempie di libri vuoti.
Prove: `lib/rewards/vista-board.test.js` **21/0**, **6 rosse** sul comportamento vecchio. Referto:
`data/ricerca/vista-board-simulazione.json`.

**202** · D-D · IL RIFERIMENTO DEL GUARDIANO NON NASCEVA DA UN CAPITALE MAI ESISTITO — 21 agosto.
`riferimentoUsd: 1550.17633` fissato il 16/08 19:28:00.990Z da **una lettura sola**: saldo $1.493,07
(DOPO la chiusura delle posizioni) + posizioni $57,103 (PRIMA) — l'osservatore misura $1.497,05 un minuto
prima e $1.493,08 un minuto dopo, e lo scarto e' **$57,10 esatti**, cioe' il valore delle posizioni.
**LA CAUSA E' UN'ASIMMETRIA, NON UNA SOGLIA**: lo SCATTO pretende due letture distinte e contigue (k=2,
perche' il segnale ha salti fino a $74,47 che rientrano al campione dopo), il CRICCHETTO accettava **k=1**
— e un transitorio verso il basso rientra, uno verso l'alto **resta per sempre**. ⚠ **ERANO DUE STRADE**:
a posizioni «ferme» (anche perche' lo snapshot non e' stato riletto) il salto del solo saldo soddisfa pure
`rilevaMovimentoEsterno`, che alzava il riferimento per conto suo; chiuderne una non bastava. **LA REGOLA:
il riferimento SCENDE SUBITO, SALE SOLO SU CONFERMA** — candidato → seconda lettura distinta (stessa
costante dello scatto, **importata**) → sale al **minimo delle due**; rientro ⇒ scartato; deposito
assorbito dal massimo mobile invece che dal rilevatore. Unica eccezione dichiarata: la **prima** lettura
in assoluto crea il riferimento senza conferma.
**IL COSTO**: 3,5-3,8% dei 5% di budget mangiati **in permanenza** (PnL a riposo fra −$54,92 e −$59,41 dal
17 al 21/08) · **4 pre-allarmi e 1 SCATTO** (20/08 22:36:02, −$111,77) · ordini cancellati e bot su FERMA
per **6h06m**. **LA MISURA**: la funzione VERA su **8.812 campioni reali** alza il riferimento 3 volte in
6,2 giorni e finisce a **$1.501,63** — lo stesso numero del calcolo indipendente «massimo sostenuto da due
letture». Riferimento $1.550,18 → $1.501,63 · drawdown −$55,39 → **−$6,85** · margine $22,12 → **$68,23** ·
punto di scatto $1.472,67 → $1.426,55. **Replay su 10.711 letture vere (4,01 giorni, non 7: il log parte
dal riavvio del 17/08): 4 pre-allarmi + 1 scatto col vecchio, 0 e 0 col nuovo**, e lo scatto del 20/08 non
avverrebbe (−$63,22 contro −$75,08, margine $11,86).
⚠ **LA SOGLIA NON E' STATA TOCCATA** (5%): il difetto era il riferimento. Le escursioni giornaliere
«misurate a $38» erano in parte lo stesso artefatto — il 19/08 scende da **$38,70 a $1,92** togliendo il
picco a un campione; le vere sono $32,05 e $38,12, contro un margine di $68,23.
⚠ **ALLENTA IL PUNTO DI SCATTO DI $46,12, ED E' IL VERSO VOLUTO**: `tot <= 0,95·rif`, quindi un
riferimento che sale piu' piano puo' solo abbassarlo. Non puo' far scattare PRIMA, per costruzione.
⚠ **RESTA APERTO IL VERSO OPPOSTO, DICHIARATO E NON CORRETTO** (§5.2): lo stesso disallineamento fra le due
fonti produce il transitorio verso il BASSO — il 20/08 22:36 il guardiano leggeva $1.438,41 mentre
l'osservatore, nello stesso minuto, leggeva $1.492,81: **$54,40 di divario**. Vive in `valutaCapitale`, non
nel riferimento.
Prove: `guardian-riferimento-non-supera-il-confermato.test.js` **26/0**, **11 rosse sul sorgente vecchio**,
dove riproduce il valore di produzione ($1.550,17933) dai numeri veri; `guardian-riferimento.test.js`
**32/0** con due blocchi **riscritti non ammorbiditi**. Referto: `data/ricerca/d-d-riparazione-21-agosto.md`.

**201** · D-C · IL FIGLIO DEL PIANO ANDAVA IN OOM: IL LETTORE DEL GIORNALE LEGGEVA TUTTO, DUE VOLTE,
E TENEVA CIO' CHE NESSUNO LEGGE — 21 agosto. `loadJournal` moriva a **924 MB**, 4 cicli su 4 al
giorno **dal 19 agosto**, con ~430 MB liberi. Tre cause MISURATE
(`data/ricerca/d-c-dove-va-la-memoria.json`): ① leggeva **tutti e 7** i file (1.295 MB) e filtrava la
finestra **dopo** aver parsato; ② `readFileSync` + `split('\n')` ⇒ stringa intera **e** array delle
righe in heap insieme, ~566 MB di transitorio sul file da 283 MB; ③ `{ ...r, tsMs }` copiava la riga
INTERA — **887 B/riga** ritenuti. **`no` (45,2%) e `levels` (40,1%) sono l'85,3% del testo e nessun
consumatore di righe di giornale li legge** (le occorrenze di `.levels` nel piano sono tutte su
oggetti CURVA del knapsack). ⚠ **La data non e' un caso**: il 19 agosto `no` entra in servizio (§5.2
p.43) e il file giornaliero passa da ~148 a ~283 MB; l'ultimo piano pesante riuscito e' del **19/08
15:25**. ⚠ **Il repo aveva gia' preso meta' della decisione nel posto sbagliato**: `allocator.js:1407`
fa `r.levels = undefined` — ma DOPO `loadJournal`, cioe' dopo il picco.
**LA CURA, senza alzare nessuna soglia** (alzare `--max-old-space-size` qui sposterebbe l'OOM killer
su agent40/agent41): filtro dei file **per nome** con un giorno di margine · **streaming a chunk da
4 MB** (`StringDecoder`, o un multi-byte a cavallo di due chunk diventa `malformed`, cioe' un dato
perso in silenzio) · **`scartaCampi` OPT-IN**, che COSTRUISCE la copia magra invece di sfoltire
quella grassa. **MISURATO sulla finestra vera di 48 h: 7 file → 4, picco 924 MB → 302 MB, riuscito in
29-33 s su 251.904 righe / 657 mercati.** ⚠ **Nessuno dei due cambi basta da solo**: col solo filtro
sui file va **ancora in OOM** a 650 MB. ⚠ **La corsia del backtest non cambia**: `scartaCampi` assente
⇒ comportamento identico, provato con **145.470 confronti campo-per-campo, 0 divergenze** (§5.2 p.50).
**⚠ NESSUN RIAVVIO, e non per prudenza**: `journal.js` ha un solo importatore, `allocator.js:1380`,
**dentro `planFromCollection`**, cioe' nel FIGLIO che rilegge da disco a ogni giro (§5.3); agent41 non
ha nessun `require` reale dei due moduli — l'unica occorrenza (`:518`) e' **un commento**.
**IL COSTO in 47 ore**: 8 cicli pesanti su 8 falliti · **48,7 h** su un piano vecchio ·
`confrontoDiValore` **mai** misurato · `collector-priority` sceso da **60 a 40** mercati (39 scaduti,
2 freschi), tenuto in vita solo dal **gradino 5 `risveglia-feed`** che lo riscriveva dal piano di due
giorni prima · **il gradino 6 avrebbe messo il bot su FERMA 10 volte in 48 h**. ⚠ Attribuzione
onesta: la scala parte per **capitale al lavoro 17,9%**, che e' strutturale (5 × $61,25 su $1.494); il
contributo dell'OOM e' che il **gradino 1 non puo' riuscire**, quindi la scala arriva ogni volta a 6.
⚠ **Spodestamenti mancati: NON misurabili** — il netto della selezione viene da un figlio diverso e
piccolo che non va in OOM, e la rotazione infatti ha continuato.
Prove: `scripts/rewards-replay/lib/journal-memoria.test.js` **11/0**, che misura il picco REALE
(`VmHWM`) di un figlio con l'heap capato e **cade sul sorgente vecchio** (5/2, il figlio non
sopravvive). Referto: `data/ricerca/d-c-riparazione-21-agosto.md`.

**200** · D-A · LA SELEZIONE ORDINAVA CON UNA CIFRA DA MOSTRARE — 21 agosto. `agent41:1357` costruiva
la mappa dei netti da `bestNetPerDay`, che `net-per-day.js:80` **annulla** senza fill osservati
(`nessun-fill-osservato`): un mercato mai quotato non ha fill, quindi non ha netto, e
`spodestaAbbastanza` rifiuta un netto `null`. **Non una soglia: una maschera di visualizzazione usata
come ingresso di una decisione.** Ora si usa `bestObiettivoPerDay` con ripiego su `bestNetPerDay` —
la forma IDENTICA gia' adottata l'8 agosto in `collector-priority.js:185`, non una seconda forma.
**MISURATO col runner VERO sul board del 21/08**: classificabili **9 → 22** su 22 ammissibili; i 13 che
si sbloccano hanno tutti `nessun-fill-osservato`; sui 9 in comune il divario e' **0 su 9** — non cambia
un valore, toglie una maschera. **⚠ IL FILL OSSERVATO NON SI PERDE**: `bestObiettivoPerDay` E'
`best.net5m`, cioe' lordo meno il costo di adverse selection misurato (`net.js:93`: zero fill ⇒ costo
zero KNOWN), e quattro occupanti su cinque stanno infatti a netto NEGATIVO. **⚠ LA SIMULAZIONE A SECCO DAVA ZERO SPODESTAMENTI, E IN
PRODUZIONE NE E' AVVENUTO UNO IN CINQUE MINUTI — con 2 ordini veri cancellati.** Non un errore di
metodo: **il board si e' mosso** (24 ammissibili alle 15:0x, 35 alle 15:33) e lo sfidante vincente
non esisteva al momento della simulazione. **Una simulazione a secco su un board vivo scade col
board.** Lo scambio e' quello voluto — occupante a **−$0,0627/g** sostituito da uno a **+$3,6558/g** —
e la regola che cancella e' preesistente (`selezione-mercati.js:992`: si spodesta un occupante con
ordini vivi SOLO se il suo netto e' negativo e quello dello sfidante positivo). Posizioni zero ⇒
nessuna gamba nuda. Verificato che la correzione sia la causa: lo sfidante aveva
`bestNetPerDay: null` / `nessun-fill-osservato`, quindi prima era invisibile.
**Stato dopo: 10 ordini su 5 mercati, 5 coppie su 5 SIMMETRICHE, posizioni 0, equity invariata.**
⚠ La selezione NON era ferma del tutto: 12 spodestamenti nelle 24 h precedenti, fra i mercati CON
storico. Congelata era la **candidatura di chi non ne ha**, oggi 13 su 22.
Prove: `lib/maker/selezione-ordina-a-priori.test.js` **15/0**, che fa girare `decidiSelezione` VERA e
**fallisce sul criterio vecchio** (asserzione ②) e sul **sorgente** vecchio (blocco ⑥, commenti
filtrati). Referto: `data/ricerca/d-a-riparazione-21-agosto.md`.
⚠ Scrivendo il test sono cadute due trappole, entrambe prese dal test e non dalla rilettura: con
`max: 1` lo `slotCorti` vale 0 ⇒ la coda lunga ha budget 0 e ogni candidato oltre 7 giorni finisce in
`scartatiPerCodaLungaSottoPavimento`; e a `max: 1` il secchio unico si chiama **`alto`**, quindi uno
`scaglione` stantio nello stato blocca lo scambio in silenzio (§5.2 p.51).

**199** · D1 · L'ULTIMA COPIA: LA STIMA REALISTICA DIVIDEVA PER IL MID — 21 agosto.
`realistic-estimate.js:269` faceva `(C/2)/mid`, la forma che l'intestazione di `size-da-capitale`
dichiara SBAGLIATA da 1'12 agosto. Corretta in `C / (1 − 2d)`.
**⚠ IL `/2` NON ERA UNA CONVENZIONE DEL CHIAMANTE**, ed e' la differenza col gemello di stamattina: in
`reward-price-row` era il CHIAMANTE a dimezzare e la correzione andava fatta li'; qui `capitalUsd` e'
gia' il TOTALE (`allocate.js:167`, `capital: 2 * sizeUsd`) e il `/2` era interno alla formula sbagliata,
quindi sparisce con lei. **Nessun chiamante toccato**, e un blocco del test lo verifica invece di
prometterlo.
**LE DUE META' DELLA CATENA ORA CONCORDANO AL BIT**: obiettivo `curve.shareForCapital(..., pairCostUsd)`
e stima `sharePerLato(capitale, pairCost)` danno la stessa size, divario 0 o 7,11·10⁻¹⁵.
**⚠ `1 − 2d` VIVE ADESSO IN UN POSTO SOLO**: `size-da-capitale.costoCoppiaAllaDistanza`, importata da
`realistic-estimate` e da `rewardScore` (che ci ha rinunciato alla propria copia scritta ieri). Restava
una terza copia in `allocate.js:387` (`pairCostForMarket`): **non toccata**, e' la corsia del backtest,
dichiarata in §5.2 p.50.
**⚠ NESSUN RIAVVIO, E NON PER PRUDENZA**: il piano nasce in un **processo figlio** che rilegge il codice
da disco (§5.3), quindi la correzione e' entrata in servizio da sola. I quattro agent vivi caricano
`rewardScore` e `size-da-capitale` in memoria, ma la modifica al primo e' numericamente identica
(delega alla SSOT) e al secondo e' **solo additiva**: comportamento in-process invariato. **Nessun
ordine e' diventato PRE-ESISTENTE.**
Prove: `stima-realistica-denominatore.test.js` **20/20**, rosso sul sorgente di ieri sull'asserzione ①.
Suite **231 verdi / 7 rossi**, gli **stessi 7** di prima e non otto. `rewards-realistic-estimate-selfcheck`
47/47.

**198** · D1 · IL PUNTEGGIO DIVIDEVA IL CAPITALE PER IL MID, NON PER IL COSTO DELLA COPPIA — 21 agosto.
`lib/rewardScore.js` convertiva capitale→share con `capital/mid` mentre il piazzamento usa
`size-da-capitale.sharePerLato` (`capital/pairCost`): due formule per la stessa domanda, ultima copia
sopravvissuta della famiglia che §5-bis aveva gia' chiuso in `minSizeVerdict` e in `net.js`.
**Il denominatore giusto viene dal VENUE, non dalla simmetria col piazzamento**: il venue scora SHARE,
e una posa bilaterale simmetrica a `s` centesimi costa `(mid − s/100) + (1 − mid − s/100) = 1 − 2s/100`
per share — **il mid si cancella**. `capital/mid` e' la size di una posa UNILATERALE: finanzia un lato
e ne scora due, e su un mid fuori da [0,10 · 0,90] quella posa varrebbe ZERO — cioe' l'errore era
massimo (**9,56×** misurato su «1 Fed rate cut», mid 0,095) esattamente dove la posa non prenderebbe
niente. Fattori sui 4 mercati a libro: **9,56× · 8,10× · 1,92× · 1,10×**; la stima viva passava da
**$1,3389/g** a un valore coerente con la formula del venue sul book vero (**$0,0907/g**).
**TRE RIGHE, UNA CATENA SOLA, E VANNO INSIEME**: `estimateCapitalLevelRange` (produce `levels`),
`recoverCompetitorQ` (ne e' l'**inversa algebrica** — correggerne una sola falserebbe `competitorQ` in
silenzio) e `quadraticUserShare` (produce `refShare`, cioe' il «$/giorno» del pannello, via
`rewards-normalize:137`). ⚠ **`competitorQ` era ed e' rimasto CORRETTO**: l'errore si cancella nel giro
andata-ritorno, e infatti coincideva con la misura indipendente sul book (0-4%).
⚠ **`capital` ORA E' IL TOTALE delle due gambe, non un budget per lato**: con la coppia «per lato» non
e' esprimibile (le due gambe devono portare la stessa size). Corretto l'unico chiamante che dimezzava,
`reward-price-row.js` — continuare a dimezzare avrebbe sottostimato di **esattamente 2×**.
⚠ **LA CLASSIFICA NON CAMBIA, E NON PERCHE' I NUMERI SIANO UGUALI**: la selezione ordina col
**netto-knapsack iniettato** e usa `punteggio()` (il numero corretto qui) solo come **ripiego
dichiarato** per i candidati senza netto, che `ordinaCandidati` mette comunque **dopo** tutti quelli
col netto. Misurato con la funzione vera: ordine **identico** col netto, **diverso** senza.
⚠⚠ **E LO SPODESTAMENTO NON LEGGE AFFATTO QUESTO NUMERO**: il blocco 3-bis e' dentro
`if (nettoPerMercato && ordiniLeggibili)` e passa solo da `nettoDi()`. **Quindi la correzione non puo'
cancellare nessun ordine gia' a libro** — l'unica superficie che cancella e' lo spodestamento.
Prove: `lib/rewardScore-denominatore.test.js` **17/17**, rosso sul sorgente di ieri sull'asserzione ①
(«a parita' di tutto il resto il mid non cambia il punteggio»: 0,3333 contro 0,0476). Suite **230
verdi / 7 rossi**, e i 7 sono rossi **anche prima** della modifica, verificato uno per uno.

**197** · IL BANCO VERIFICA TUTTE E DIECI LE REGOLE CONCORDATE — 18 agosto, `176c5a5`. Sei passi nuovi
(18-23), uno per ogni regola che non aveva prova o che era coperta di sponda: **26 passi su 26**, 0
annotati. ⚠ Il passo 23 e' caduto alla prima corsa e il codice era GIUSTO: il predicato guardava
`uscenti`, ma un occupante spodestato finisce in `spodestati`/`liberati` — `uscenti` sono quelli che
escono da soli, gli spodestati sono cacciati. L'errore cadeva nella direzione giusta.

**196** · R4 · L'EROSIONE DELLA PROFONDITA' DAVANTI TOGLIE L'ORDINE DAL LIBRO — 18 agosto, `1b8b34c`.
Regola per intero in **§4.1-bis**. `book-erosion` era cablato solo in `mm-tracking`, motore senza un
mercato configurato. ⚠ Senza il registro su disco (`sospensione-erosione.js`) la regola non esisterebbe:
`ripristinaGamba` parte SUBITO e avrebbe rimesso a libro entro 120 s. ⚠ Scrivendo il test ho sbagliato
DUE volte la firma di `decideReprice` (`deps` e' il secondo argomento posizionale, la manopola si chiama
`config`) e in entrambi i casi il trigger veniva saltato **in silenzio col test verde**: §5.3.
Prove: `sospensione-erosione` 32/0, `erosione-scatta` 39/0 (cade 7 volte senza il TRIGGER 4).

**195** · R1 · QUANTI MERCATI VIENE DALL'AMBIENTE, E LA COMPOSIZIONE LO DERIVA — 18 agosto, `0ac9bd1`.
Regola in §4.13. Il 3 era cablato **due volte** — `MAX_MERCATI_CONTEMPORANEI` e i tre posti di
`QUOTA_SCAGLIONI` — e agent41 non passava nemmeno `max`. ⚠ E il soffitto era ACCIDENTALE: `max: 10`
faceva entrare 3 solo perche' la tabella aveva tre posti; ora il clamp e' esplicito, e `quanti-mercati`
**importa** la costante invece di riscriverla. Prove: `quanti-mercati` 20/0, `selezione-mercati` 104/0.

**194** · R10 · IL KILL A −$100 CHIUDE ANCHE LE POSIZIONI — 18 agosto, `5d86bd1` + `bb6d19c`. Regola in
§3. Chi decide (agent43) non esegue, chi esegue (agent41) non decide. ⚠ IL DIFETTO TROVATO COLLEGANDOLA:
il presidio dei 60 minuti — «l'ultima rete» — sta dietro `botAttivo()`, cioe' **non gira a bot FERMO**,
che e' lo stato che il kill produce. ⚠ E il test del cablaggio ha preso un difetto che il selfcheck non
vedeva (chiave della mappa dei minimi sensibile al maiuscolo). ⚠ E `kill-perdita-giornaliera.test.js`
scriveva nel `data/` di **produzione**: percorso reso iniettabile, e ora c'e' l'asserzione su *dove non*
ha scritto. Prove: `chiusura-di-emergenza` 24/0, `kill-chiude-le-posizioni` 27/0.

**193** · R6 · IL RESIDUO SOTTO IL MINIMO SI CHIUDE — 18 agosto, `1131841`. Il presidio dei 60 minuti lo
TENEVA con un motivo vero fino al 17 e falso dal 18: reperto **D7** nella forma peggiore, un commento
invecchiato che tiene fermo capitale. Il limite «non spendere per uscire piu' di quanto valga» su una
VENDITA equivale a `ricavo >= 0`, quindi morde in un caso solo — ricavo NULLO — e quel caso ora si
rifiuta. ⚠ NON implementata la meta' che morderebbe davvero (comprare oltre 101¢ per sbloccare col
merge): non esiste un percorso che compri sopra il tetto, e inventarlo sarebbe un meccanismo nuovo.

**192** · R7 e R8 · LA CONCESSIONE E' IL 5%, E LA COPPIA COMPLETA SI FONDE PRIMA DELLE GUARDIE SUL
PREZZO — 18 agosto, `93fa78b` + `759c09f`. Regole in §4.6. R7 **allarga un limite di rischio** ($3,06
contro $0,63) ed e' una decisione dell'operatore. R8 e' monotono: si tolgono due rifiuti, non si aggiunge
un acquisto. Prove: `urgenza-scoperto` 27/27, `scoperto-oltre-soglia` 38/0, `uscita-arriva-a-esecuzione`
23/0 (dove si vede la differenza: il pavimento passa da 53¢ a 51,3¢ e l'uscita ARRIVA al bid),
`strategia-merge` 52/0 (cade 5 volte sul sorgente di ieri).

**191** · LE CINTURE DA CINQUE A QUATTRO, E LE QUATTRO MORDONO — 17 agosto, decisione dell'operatore.
Regola per intero in **§4.14**. `MAKER_PLACEMENT` tolta (nessun chiamante); `MAKER_MODE` e
`MAKER_ADAPTER_DRYRUN` passate a `buildPlacementAdapter` e lette da `cinture-armamento` — non piu' uno
specchio da confrontare ma **la** lettura, usata per raccontare lo stato e per deciderlo. Prova:
`prova-cinture.js` **10/0**, ognuna inserita DA SOLA col CONTROLLO che parte. ⚠ E il banco era piu'
permissivo del venue: il suo adapter cablava modo/dryRun/placement ignorando gli `opts`.

**190** · IL PASSO 13 SCEGLIEVA IL SOGGETTO DALLO STATO — 17 agosto, `adc57a5`. Ora se lo COSTRUISCE e lo
apre da `giro()` + `controlloCapitaleFermo()`: servono entrambi, perche' `ripristinaGamba` pretende una
riga nel piano SALVATO e quel file lo scrive solo il ciclo pesante. Determinismo 10/10, e **identico su
due snapshot diversi di `data/`** dopo aver aggiunto `maker-allocated-capital.json` ai file azzerati dal
passo 1 — l'unica memoria di un piano precedente a sopravvivere all'«accensione da zero».

**189** · I FILE DI SERVIZIO IN `/tmp` ERANO DI `root`, E I LETTORI NON SE NE ACCORGEVANO — 17 agosto.
`/tmp` e' condiviso e ha lo sticky bit: dopo la migrazione l'utente nuovo non poteva ne' riscrivere ne'
cancellare i nove file di ieri. Gli scrittori prendevano EACCES **e i lettori continuavano a leggere la
copia vecchia, che da quel momento non invecchiava piu'** — un prezzo di quaranta minuti prima
presentato come di adesso. Cura: `lib/percorsi-runtime.js`, directory **per utente**, una definizione al
posto di ~40 letterali in 23 file. Il guasto non e' riparato: e' reso **inesprimibile**. Piu'
`lib/safety/percorsi-critici.js`, chiamato dai nove agent che scrivono: su percorso inutilizzabile
stderr + exit 1 invece di degradare in silenzio (test 15/0, che costruisce ogni guasto e lo rimette a posto).

**188** · LA MIGRAZIONE DA `root` A `bot`: DODICI PERCORSI CABLATI, E NESSUNO FALLIVA RUMOROSAMENTE —
17 agosto 2026, `57de3e8` + `abed26d`. Il repo e' in `/home/bot/bot`, l'utente e' `bot`, `/root` non e'
leggibile. I dodici: **11 `cwd` + 11 `HOME`** in `ecosystem.config.js` · `rewards-normalize` e il suo
**gemello scrittore** `agent24.OUTPUT_FILE` · `agent34` watchlist/mid-history/trade-tape · `agent45` ·
il RUNNER dell'allocatore · `rewards-selfcheck` · e il **`VIVO` del banco**, dove il guasto era peggiore:
`diff` su una directory illeggibile esce **2**, il `catch` prendeva `e.stdout` vuoto e leggeva zero
differenze — **il cancello dell'identita' del codice si APRIVA**. La regola generale e' in §5.3.
**E LA POLICY DEI PERMESSI ERA LA PARTE PEGGIORE**: l'hook `PreToolUse` puntava a `/root/...` ⇒ **non
girava piu'**; le 7 regole `Edit(//root/...)` non corrispondevano a niente, cioe' `.env`,
`ecosystem.config.js` e i sei flag di stato erano modificabili **senza `ask`**. Rimessi: hook su
`$CLAUDE_PROJECT_DIR`, 164 `ask` in entrambe le copie. **Due rossi noti diventano verdi** e nessuno dei
due era un difetto del codice (`hook-piazzamento` 70/0, `policy-permessi` 84/0).

**187** · I RESIDUI SOTTO IL MINIMO: LA VIA D'USCITA ESISTE GIA' — 17 agosto. Caso peggiore **$46,79**
su un mercato, **bloccato adesso $3,00**. Si conta su UN LATO SOLO: un residuo su entrambi i lati e' una
coppia parziale, e il **merge on-chain non ha minimi di size**. L'uscita non passa dal libro — il
**riscatto on-chain** (p.131, cablato) — quindi il costo non e' il capitale ma il **tempo** fino alla
risoluzione. ⚠ Da R6 (18 agosto) il residuo si **chiude** anche dal libro: v. §4.6.

**186** · OLTRE 7 GIORNI NON C'E' NIENTE DA QUOTARE A $147 — sola misura, 17 agosto. 5 candidabili su
145, tutti a lordo **$0,00/g** contro 3.846-147.564 share altrui ⇒ netto negativo. Il valore sta a **~1,3
giorni**: 11 dei 31 ammissibili in positivo, il migliore **$60/g** con concorrenza zero. ⚠ Il primo conto
filtrava su `candidate.horizon`, `undefined` per 31 righe: un `Number(null)` travestito da misura.

**185** · DELLE CINQUE CINTURE NE MORDE UNA — 17 agosto 2026, sera tardi. Regola per intero in **§4.14**;
la sequenza di armamento che ne consegue e' in `APERTI.md`. Trovata preparando quella sequenza, non da un
guasto: `createMakerAdapter` ha un solo chiamante, che cabla `mode:'live-min'` e non passa `dryRun`.

**184** · `stato.js` LEGGE LE CINTURE DAI PROCESSI VIVI, E LO SPECCHIO E' PROVATO — 17 agosto sera.
`lib/maker/cinture-armamento.js` (puro) risponde per un ambiente qualunque; `stato.js` gli passa
`/proc/<pid>/environ`. Due delle cinque sono **importate**, le altre tre sono uno specchio dell'adapter — e
il test (24 asserzioni, adapter VERO) ha trovato **due divergenze mie nella direzione che costa**:
normalizzavo `MAKER_MODE`/`MAKER_ADAPTER_DRYRUN`, mentre `config` confronta i valori **esatti**. Uno
specchio deve essere esatto, non ragionevole. ⚠ `puoPiazzare` dice che le cinque sono aperte, non che
l'ordine passerebbe (`evaluatePlacementGate` ha anche gate che non sono cinture).

**183** · IL CARICO DI RIPIEGO ARRIVA AL SECONDO LIVELLO — 17 agosto. `deps.ultimoNostroPrezzo` non era
cablata: **settima** occorrenza di §5.3. Ora il prezzo viene dal **giornale** e non dalla memoria di
processo; contano solo gli invii accettati e solo i BUY (`manual-replace` ha ricevuto `side`).

**182** · IL PASSO 13: DUE FUNZIONI DIMENSIONAVANO LA STESSA COPPIA IN DUE ISTANTI DIVERSI — 17 agosto
sera. Regola per intero in §4.13; `coppia-simmetrica.js` puro, 30 asserzioni + 21 sul cablaggio.
⚠ **La diagnosi precedente («il riprezzo ricalcola la size») era sbagliata**: chi riapre non la rifaccia.
⚠ Il conteggio del banco scende da 22+17 a **21+16**: meno rifiuti da esercitare, non meno copertura.

**181** · TRE DIFESE ERANO INERTI, E LE HA TROVATE IL BANCO — 17 agosto, `e3dcfb0`. Il kill a −$100 leggeva
`lim.maxDailyLossUsd` invece di `{ok, limits:{…}}`; il rilascio per scadenza leggeva `p.ids` invece di
`conditionIds`; `BOARD_NORMALIZZATO` era l'ultimo letterale su cinque lettori. **Tutte e tre coperte da
test verdi**, perche' iniettavano fixture di forma INVENTATA: provavano la decisione, non il cablaggio.

**180** · IL GIRO COMPLETO, DETERMINISTICO — 17 agosto, `1b7a4e7`+`e3dcfb0`. Le fonti di caso erano quattro
(`Date.now`, `new Date()` argless, `Math.random`, lo stato del riprezzo fra le corse).

**179** · IL BANCO CHIAMA `closeTask()` E `giro()`: IL «37 SU 91» ERA UNA COPIA — 17 agosto, `226471b`.

**178** · IL KILL A −$100 CANCELLA: SECONDO INGRESSO DEL GUARDIANO — 17 agosto, `e838c82`. Una sola azione
(`spazzaEFerma`), due ingressi; fail-closed al contrario (perdita non leggibile ⇒ NON si cancella).

**177** · IL PIANO SALVATO NON SOPRAVVIVE A UN CAMBIO DI SELEZIONE, E LA SCADENZA TOGLIE DAL PERIMETRO —
17 agosto, `3e9b549`. `righeAmmesse` (una funzione per entrambe le fonti) e `scadenzeFuoriPerimetro`.

**176** · IL RESIDUO SU FILL PARZIALE SI CANCELLA SEMPRE E SUBITO — 17 agosto, `3eccec2`. Regola in §4.6;
la condizione precedente era una tautologia e la guardia vera era «solo il primo giro».

**175** · IL PERNO `MAKER_LIVE_MIN_MARKET` RESTRINGE INVECE DI AGGIUNGERE — 17 agosto. Regola in §4.8; tre
copie della stessa aritmetica ridotte a `adapter.perimetroLiveMin`. Monotonia esaustiva su 80 combinazioni.

**174** · I DUE PRESIDI DI agent40 NON DIPENDONO PIU' DAGLI AVANZI — 17 agosto. `VENUE.azzera()` + ricarica
da `require.cache`: la memoria di modulo era il terzo avanzo, e `nostriInvii` di una fase precedente
SPEGNEVA l'allarme. Le tre verifiche sanno cadere, provato su copie.

**173** · LE SEI FIXTURE DEL BANCO, PROVATE PER SOTTRAZIONE — 17 agosto. **18 delle 20 regole statiche** si
spegnevano per UNA sola fixture, e tutte e 17 le dinamiche. Nessuna delle 60 rosse ne era vittima.

**172** · COSA E' SUCCESSO ALLE GAMBE IL 16 AGOSTO — sola misura. 377 ordini, 8 mercati, 133 cadute da due
gambe a una, **copertura piena 50,0 %**. ⚠ 111 cadute durano 3,4 s (il riprezzo); le **22 lunghe valgono il
97,8 % dei minuti** e 17 non sono mai tornate. Referto `data/ricerca/gambe-16-agosto.md`.

**171** · LA COPERTURA CONTINUA RIMETTE LA GAMBA A LIBRO, CON UN RAFFREDDAMENTO — 17 agosto. Regola in
§4.13; `riconciliaCopertura` dichiarava e non agiva. Il numero che governa il disegno e' **720** (i cicli
al giorno): contenimento provato, 50 tentativi su 720, fattore 14,4x.

**170** · I SETTE TEST ROSSI, PIU' UNO, PIU' TRE SELFCHECK — 17 agosto (da 19 rossi a 12)

**169** · LA PRESA DI PROFITTO DECIDE SUL BID CAMMINATO, MAI SUL MID — 17 agosto. Regola in §4.6. 283
campioni su 354 minuti: ZERO istanti offrivano un'uscita in guadagno; il «guadagno» era la differenza fra
mid e bid. Un take-profit esisteva gia' (`marketAhead`) e non ha mai incassato niente.

**24 · 23 · 22 · 20** · le quattro misure chiuse del 13 agosto — diagnosi in `git log` e `data/ricerca/`.

**27** · I 5 SELFCHECK DI `scripts/` RIMESSI IN SCALA — 15 agosto (rifatto il 17: v. p.170)

**21** · IL PAVIMENTO DI PROFONDITÀ NON SI APPLICA PIÙ AI RINNOVI — 16 agosto, `63c10a0`. ⚠ Misura del
17: **2.100 blocchi**, tutti fra le 11:00 e le 15:59 e **zero dopo le 16:00**, cioè dopo il commit.
Costo: **65,0 minuti** di gamba singola.

**168** · IL TETTO DI ESPOSIZIONE ESENTA LE CHIUSURE PROVATE, E SCENDE A $150 — 16 agosto 2026

**167** · SELEZIONE A TRE, PER COMPOSIZIONE, CON ROTAZIONE — decisione dell'operatore, 16 agosto 2026

**166** · FILL PARZIALE: IL RESIDUO NON SI CANCELLA ALL'INGRESSO, MA ALLA COPPIA — 16 agosto 2026

**165** · UN SOLO TETTO DI COPPIA, 101¢, E LA RESA A 60 MINUTI — decisione dell'operatore, 16 agosto 2026

**164** · IL TETTO PER ORDINE ERA «METÀ MERCATO» E RIFIUTAVA LA GAMBA CARA ($35,63 → $65,63, causa a
monte di `coppia-non-atomica`); IL BORDO DELLA BANDA ERA NUDO (`bordiConMargine`, `max(1 tick, 0,22·v)`,
Schmitt trigger, tetto a metà banda) — 16 agosto 2026. **Le due regole per intero in §4.2 e §4.1**;
`distanza-obiettivo.test.js` blocco ③-bis, 58 asserzioni.

**163** · GLI «EFFICIENTI» DENTRO I 65: CAPITALE PICCOLO E TRADING IN PARI — ricerca, 15 agosto

**162** · COME ESCONO I 65 DOPO UN FILL — ricerca, 15 agosto

**161** · CHI FA DAVVERO LIQUIDITY REWARDS, E DOVE QUOTA — ricerca, 15 agosto

**160** · LA MANOPOLA DELLA DISTANZA ACCESA A 0,444 — TEST DELL'OPERATORE, 13 agosto 2026, sera

**159** · IL GRADINO 6 DISARMATO PER CONFIGURAZIONE — decisione dell'operatore, 13 agosto 2026, sera

**158** · LA MANOPOLA DELLA POSIZIONE, INSTALLATA E SPENTA

**157** · IL RIFERIMENTO DEL GUARDIANO: DRAWDOWN DA MASSIMO MOBILE

**156** · IL TETTO PER MERCATO PASSA A $61,25, E SMETTE DI DERIVARE DA `f_min`

**155** · LA BANDA PREMIANTE ERA LARGA LA METÀ — `v = max_spread`, NON `max_spread/2`

**154** · IL FILTRO DI PROFONDITÀ NON STA AFFAMANDO IL PIANO — misura, niente toccato

### Le tre voci del 13 agosto 2026

**120** · IL DEADLOCK ARITMETICO CHE HA FERMATO IL BOT PER TRE ORE

**121** · LA SENTINELLA SUL VUOTO

**122** · UNA POSIZIONE SENZA SCADENZA È UNA POSIZIONE CHE NESSUNO CHIUDERÀ

**123** · I RESIDUI SOTTO IL MINIMO — chiuso da §5-bis p.187 e da R6

**138** · LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA — ⚠ **la diagnosi era sbagliata**, corretta il 16
agosto: l'orologio NON si azzerava. Le due cause vere sono in §4.6: chi riapre non rifaccia la diagnosi.

**152** · IL BORDO DELLA BANDA NON CONVIENE — ⚠ numeri corretti da p.155

**151** · IL REDEEM È UNA VIEW, NON GESTIONE DEL RESIDUO — corregge §150

**150** · COSA FANNO GLI ALTRI DOPO UN FILL — sola ricerca

**149** · CHI INCASSA DAVVERO I REWARD — ricerca, 30 giorni on-chain

**147** · L'ESENZIONE DAL TETTO PER ORDINE VALE SU TUTTI I PERCORSI CHE RIDUCONO

**148** · IL REGISTRO DEI RESIDUI HA FINALMENTE UN CONSUMATORE

**145** · LE DUE CONFERME DEVONO ESSERE DUE OSSERVAZIONI, NON DUE COPIE

**146** · I RESIDUI BLOCCATI, MISURATI — diagnosi

**144** · L'OSSERVATORE MUTO (agent45)

**141** · IL GUARDIANO NON SCATTA PIÙ SULLA PRIMA LETTURA (k=2)

**142** · LA SENTINELLA SUL COLLASSO DELLA COPERTURA (85%), SOLO OSSERVA

**143** · LA GAMBA SORELLA SI ABBASSA DENTRO LA BANDA

**140** · LA SOGLIA SULLA DERIVATA È 85%, E IL DIVARIO FRA LE DUE POPOLAZIONI È VUOTO — sola misura

**139** · IL SECONDO SCATTO DEL GUARDIANO — 13 agosto 2026, 09:08:33Z

### Le voci del 13 agosto 2026, sera

**124** · IL CAPITALE AL LAVORO DICEVA L'INTENZIONE

**125** · RIFIUTI RIPETUTI: RICONOSCERE E REAGIRE

**126** · COERENZA FRA I MODULI

**127** · SCALA DI SBLOCCO E AUTODIAGNOSI

**128** · RESIDUI SOTTO SOGLIA: NON SI PUÒ IMPEDIRE CHE NASCANO — con i numeri

**129** · IL FILTRO ORIZZONTE COSTA 5,4× E NON PROTEGGE DA CIÒ CHE DICHIARA — misurato

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

Solo numero e titolo: serve a risolvere «§5 punto N», il resto è in `git log`.

**1** Il bot non è mai stato avviato  
**2** La copertura dichiarata di FERMA non corrisponde al runtime di agent35  
**3** `REALLOC_SCHEDULER_DRY_RUN=1` resta nell'ambiente del processo agent41  
**4** L'header di `lib/maker/strategia-merge.js` è invecchiato  
**5** Arming disarmato da un kill ormai revocato  
**6** `data/maker-bot-enabled.json` e `data/cancellazioni-di-emergenza.json` non sono coperti da `.gitignore`  
**7** Il codice della sera del 7 agosto non è attivo  
**8** `pgrep -f <nome-processo>` non è affidabile in questa sessione  
**9** Il codice dell'8 agosto non è nei processi  
**10** L'obiettivo non sente il tetto di credibilità  
**11** Il confronto non ha ancora un dato  
**12** I cinque test rossi: diagnosi fatta, correzione da decidere  
**13** Il caso degenere della concorrenza misurata ZERO  
**14** Il lavoro sull'allocatore NON richiede riavvii, e vale la pena saperlo una volta per tutte  
**15** La rinomina non è ancora in pm2  
**16** `agent44-audit-scoperta` esiste, gira alle 03:07 UTC, e la sua coda va guardata  
**17** Il trigger a capitale fermo non è nel processo  
**18** La correzione del consumo di agent40 è in `main` ma non nel processo  
**19** IL PRIMO AVVIO NON HA UN INNESCO, e nessuno dei due percorsi lo copre  
**20** L'hook di piazzamento blocca anche il ciclo di agent41 lanciato a mano  
**21** Il trigger a $50 non ha MAI funzionato  
**22** Tre cose che il fix ha scoperto  
**23** Il tetto di orizzonte non basta: l'universo eleggibile è zero  
**24** IL 10 AGOSTO ALLE 01:01:33Z IL RESET CANCELLA TUTTO, se il board non è aggiornato per allora  
**25** La misura che ha fatto scattare tutto, tenuta come riferimento  
**26** DUE POSIZIONI APERTE SENZA VIA D'USCITA  
**27** I Livelli 1 e 2 non sono mai stati raggiunti  
**28** IL RIAVVIO DI agent40 ARMA UN COMPORTAMENTO NUOVO SU CAPITALE REALE  
**29** IL LIVELLO 1 (TAKER) NON PUÒ ESEGUIRE, ed è una protezione che NON è stata toccata  
**30** Verifica del gate fatta per test unitario, non sui dati vivi  
**31** I DUE MERCATI CON POSIZIONE APERTA SONO TORNATI NELLA ALLOWLIST  
**32** SCHWARTZEL NON COMPLETA LA COPPIA: `closeTask` NON INIETTA `cancelOrder`  
**33** La stessa guardia, un ramo più in là: `null` non è una cancellazione riuscita  
**34** TRE RIAVVII PENDENTI  
**35** Il 75,9% e non il 90%: il target non si raggiunge sempre, ed è il punto  
**36** `REALLOC_PIANO_LEGGERO_ORE` è il primo parametro che governa quanta memoria consuma un figlio  
**37** LA RICERCA SULLE CATEGORIE È FATTA, E RIBALTA LA LETTURA OVVIA  
**38** LE OTTO FASI DELL'8 AGOSTO SERA  
**39** QUATTRO RIAVVII PENDENTI per le otto fasi  
**40** I ROSSI NOTI SONO SCESI DA QUATTRO A TRE  
**41** IL MINI-CICLO SCEGLIEVA MERCATI CHE POI NON POTEVA TOCCARE  
**42** UNA GAMBA CANCELLATA BRUCIAVA LA SUA CHIAVE PER SEMPRE  
**43** IL TETTO GIORNALIERO DI APERTURE È STATO RIMOSSO  
**44** UN MERCATO CHE ESCE DAL BOARD PERDEVA LA GESTIONE  
**45** IL MERGE ON-CHAIN È COLLEGATO AL FLUSSO  
**46** IL PERIODO DEL BOARD ERA 22,5 MINUTI, NON 15  
**47** IL RIPIEGO DELLE REGOLE COPRIVA UN PERCORSO SU DUE  
**48** LO SPLIT NON VA COLLEGATO, E LA MISURA È NETTA  
**49** `CTF_RELAYER_ENABLED = true`  
**51** LA SEQUENZA COMPLETA DEL LATO SCOPERTO  
**52** IL MERGE ON-CHAIN NON HA MAI FIRMATO: `deps.signerProvider` NON ERA CABLATO  
**53** I TETTI DI CAPITALE ERANO FERMI AL CAPITALE DI TRE ORE PRIMA, E IL 90% ERA IRRAGGIUNGIBILE PER COSTRUZIONE  
**54** LA REGOLA GENERALE DEL LATO SCOPERTO  
**55** IL TETTO DELLA CATENA DI SOSTITUZIONI MURAVA UNA GAMBA VIVA  
**56** IL LIVELLO 3 USCIVA IN SILENZIO  
**57** CINQUE MERCATI FINTI NEI DATI VIVI  
**58** 🔴 IL CAPITALE ERA CONTATO DUE VOLTE  
**59** ⚠️ L'UNICA ECCEZIONE A «MAI PRIMI SUL LIBRO»  
**60** «PRIMO ASSOLUTO» SI MISURA SUL LIBRO, NON SULLA BANDA  
**61** IL BOT NON VEDEVA IL LIBRO DEI MERCATI IN CUI AVEVA DEI SOLDI  
**62** VISTI MA INTOCCABILI  
**63** 🧹 MAKER ARMING, agent35-maker E agent37-maker-watchdog SONO STATI RIMOSSI  
**64** IL TETTO DI CREDIBILITÀ ERA UN'ATTENUAZIONE E ORA È ANCHE UN CANCELLO  
**65** TETTO PER MERCATO FISSO A $130 E NESSUN LIMITE DI POSIZIONI  
**66** LA RISPOSTA AL FILL: QUATTRO CORREZIONI, E IL CABLAGGIO CHE LE RENDE EFFETTIVE  
**67** IL QUARTO PUNTO DEL TETTO: $25 PER ORDINE CONTRO $130 PER MERCATO  
**68** LA GAMBA ORFANA VENIVA RINNOVATA ALL'INFINITO  
**69** IL GATE live-min LEGGEVA LA LISTA STRETTA: L'UNIONE DEL PUNTO 62 NON ARRIVAVA AL PIAZZAMENTO  
**70** IL GUARDIANO DELLE PERDITE È SCATTATO  
**71** IL REGISTRO DA 731 MB: LETTURA INCREMENTALE SU TUTTI I PUNTI NOTI  
**72** UN FILL VALEVA UNA VOLTA PER RIPIAZZAMENTO  
**73** IL RIPREZZO È DIVENTATO ATOMICO NEL SENSO CHE CONTA: NON CANCELLA CIÒ CHE NON PUÒ RIPIAZZARE  
**74** VERIFICA COMPLETA E RIAVVIO PULITO DELLA FLOTTA  
**75** I DUE LAVORI DELL'11 AGOSTO SERA, MAI DOCUMENTATI FIN QUI  
**76** IL TETTO PER ORDINE NON RIGUARDA CHI CHIUDE, E UN TAKER NON MIRA AI PROPRI ORDINI  
**77** LA CHIUSURA RIPROVA, LA SORELLA CRESCE, E UN MERCATO MORTO NON RESTA IN SEI REGISTRI  
**78** IL PANNELLO NON DICHIARAVA I PROPRI ORDINI, E LA SELEZIONE ERA SCRITTA A MANO IN DUE PUNTI  
**79** `clobRewards` ASSENTE NON È `clobRewards` A ZERO  
**80** `inCoda` E `priceAdjusted` ARRIVANO IN `execution-audit` E SUL PANNELLO  
**81** IL LATCH DEL GUARDIANO SCADE, E NON SI FIDA PIÙ DI SE STESSO  
**82** LA PULIZIA DEI REGISTRI NON DIPENDE PIÙ DA CHI ITERA COSA  
**83** UN 429 SU `/positions` NON FERMA PIÙ IL BOT  
**84** LA BASELINE DEI TEST È CAMBIATA: 7 ROSSI, NON PIÙ 8  
**85** LA CHIUSURA FORZATA A 3 ORE ESISTEVA E NON POTEVA SCATTARE  
**86** IL CONSUNTIVO REWARD SI RECUPERA A RITROSO  
**87** IL REGISTRO DEI REWARD INCASSATI  
**88** PERSISTENZA DOPO CRASH, PROVATA CON UN `kill -9`  
**89** SOLI SUL LATO: AL BORDO ESTERNO DELLA BANDA  
**90** LA QUOTABILITÀ È UN FILTRO A MONTE, E IL CAPITALE LIBERATO SI RIDISTRIBUISCE  
**91** ⚠ LA SCANSIONE DEI REGISTRI AVEVA ROTTO UN'INVARIANTE, e un test l'ha preso  
**92** VOCE 1 · LA SOVRASTIMA DEL 465% È UN TASSO LETTO COME QUANTITÀ  
**93** VOCE 3 · LE DUE CADENZE ERANO GIÀ A TERRA: VERIFICATE E BLOCCATE  
**94** VOCE 4 · TRE CECITÀ DIVERSE SOTTO LO STESSO OROLOGIO  
**95** VOCE 5 · VERIFICA DI TENUTA DEI BLOCCHI A+B: TRE PUNTI REGGONO, IL QUARTO AVEVA UNA LACUNA  
**96** VOCE 6 · IL RESET DISTINGUE PER ORIGINE  
**97** VOCE 2 · RIAVVII AUTOMATICI ROBUSTI, E IL DASHBOARD CHE NON SI RIALZAVA  
**98** IL ROSSO CHE LA SUITE HA TROVATO, E CHE NON VENIVA DA OGGI  
**99** IL CARICATORE `.env` SUI TRE AGENT RESTANTI, MA RISTRETTO  
**100** OPZIONE A: LA STIMA DIVENTA UNA QUANTITÀ INTEGRATA  
**101** LA COSTANTE SBAGLIATA, E PERCHÉ CORREGGERLA DA SOLA SAREBBE STATO UN DANNO  
**102** UNA SOLA MISURA DI ORIZZONTE, E LO SCARTO A MONTE  
**103** IL FRENO DI PROVA, CHE PRIMA NON ESISTEVA  
**104** UNA SOLA VERITÀ SUL CAPITALE  
**105** PERCHÉ IL MINI-CICLO NON PIAZZA  
**106** IL LEDGER NETTATO, E `skipped` CHE NON SPARISCE PIÙ  
**107** IL TETTO DERIVATO  
**108** UNA SOLA FORMULA CAPITALE→SHARE  
**109** LA COERENZA A VALLE, E UNA MISURA CHE CORREGGE UNA STIMA DI OGGI  
**110** IL RAMO `skip` INGHIOTTIVA LA GERARCHIA, E LA DECISIONE USCIVA MUTA  
**111** PERCHÉ L'UTILIZZO ERA AL 7,5%  
**112** OPZIONE B: IL TRONCAMENTO PROVATO RESTITUISCE L'ORA VERA  
**113** LA «FINESTRA DI MID» NON È UN CANCELLO  
**114** I TETTI PER GIRO ALZATI, E IL TETTO ANTI-RUNAWAY CHE AFFAMAVA IL RINNOVO  
**115** IL PIAZZAMENTO DELLA COPPIA È ATOMICO IN PRECONTROLLO  
**116** LA QUOTA 60/40 SULLA FINESTRA  
**117** `REWARD_MAX_CLOB_MARKETS` È GIÀ AL MASSIMO: 150  
**118** IL CAPITALE AL LAVORO: UN NUMERO, UN OBIETTIVO, E IL FERMO RIPARTITO IN DOLLARI  
**119** L'ANELLO DEL FEED APERTO, E IL TURNOVER CHE NON SI CORREGGE DA LÌ  


## Voci di §5.2 CHIUSE, spostate qui il 22 agosto 2026 (verbatim)

### §5.2 p.49 — chiusa il 21 agosto

49. **✅ CHIUSA IL 21 AGOSTO — E LA DIAGNOSI DI STAMATTINA ERA SBAGLIATA, VA DETTO PER INTERO.**
   Avevo scritto che da `realistic-estimate.js:269` «passa il netto, cioe' il numero che ordina i
   candidati e decide gli spodestamenti». **Non e' vero, e chi riapre non rifaccia quel ragionamento.**
   `placementShareFactor` e `credibleShareFactor` sono **esportate** e ricevono `sizeShares` come
   PARAMETRO: `allocate.js:149-151` passa la PROPRIA size, che viene da
   `curve.shareForCapital(..., pairCostUsd)` — gia' corretta, e con `usePairCost` acceso per difetto
   nel piano di produzione (`allocator.js:1495`, `opts.usePairCost !== false`). La `sizeShares` della
   riga 269 e' **locale a `realisticEstimate`** e non raggiunge mai l'obiettivo.
   **LA CATENA VERA, misurata**: obiettivo `allocate.js:455` → `net.js:80 shareForCapital` →
   `level.net5m` → `allocator.js:970 bestNetPerDay` → `agent41:1357 nettoPerMercato` → selezione.
   Stima `allocator.js:841 realisticEstimate` → `realisticByTick` → `realisticBestPerDay`.
   **Prova**: l'impronta delle cinque funzioni esportate e' **identica prima e dopo**
   (`8cfcada9dcc566b6`), e le due size coincidono ora al bit (divario 0 o 7,11·10⁻¹⁵).
   ⚠ **MA :269 NON ERA SOLO DISPLAY**, ed e' l'altra meta' della correzione: `realisticBestPerDay`
   ordina le righe in **`trigger-capitale-fermo.scegliMercato:317`** (quale mercato riceve la prossima
   tranche a capitale fermo, ogni 120 s) e `totals.realisticPerDay` alimenta il **trigger di VALORE**
   del ciclo 6 h (`realloc-cycle.confrontoDiValore`). Due decisioni, non due numeri da mostrare.
   **Quanto si sposta, misurato sul board vivo (29 ammissibili)**: **uno scambio adiacente su 29**
   (posizioni 6-7, righe distanti $0,0001/g) e **la prima scelta NON cambia**. Il motivo e' che i due
   fattori sono RAPPORTI di quote: con una concorrenza di migliaia di share contro le nostre ~64 sono
   quasi insensibili alla size. Dove morde davvero e' il regime a concorrenza sottile (§5-bis p.167:
   168 share), e su questo board non c'e' nessun ammissibile li'.


### §5.2 p.54 — chiusa il 22 agosto

54. **✅ CHIUSA IL 22 AGOSTO — diagnosi integrale in §5-bis p.204.** La cura NON e' una tolleranza sui
   timestamp (misurata e scartata: lo scarto dichiarato non separa le letture contaminate dalle pulite,
   perche' lo snapshot timbra l'istante di SCRITTURA e non quello di lettura) ma la **conservazione del
   valore**: un movimento di cassa dev'essere compensato da un movimento OPPOSTO delle size, o le due
   fonti non descrivono lo stesso istante e **il totale non e' misurabile**. Chiude entrambi i versi.

### §5.2 p.37 — chiusa il 19 agosto

37. **✅ CHIUSA IL 19 AGOSTO — I TRE TEST AVEVANO RAGIONE SULLA RELAZIONE E TORTO SULLA GRANDEZZA.**
   Difendevano `maxOpenNotionalUsd ≤ N × tetto per mercato`, «o non morderebbe mai». Ma il gate somma
   `openNotionalUsd + notional` **anche sugli ordini di apertura**, e `openNotionalUsd` conta i **fill
   riconciliati**: lo stato peggiore che il bot attraversa lavorando non è «N mercati pieni», è **N
   coppie a riposo PIÙ il loro completamento**. A N=5: $306,25 + $306,25 = **$612,50**, contro un cap
   di **$650**. Invariante riscritta su quella grandezza; **il cap resta $650** (decisione
   dell'operatore).
   **⚠ NON SI SCENDE A $306**: sarebbe l'errore del 16 agosto rifatto — allora il cap fu portato a $150
   contro 3 × $61,25 «per farlo mordere», e il tetto **murò la gestione a metà strada**, rifiutando il
   BUY che completa la coppia e la SELL che liquida la gamba nuda (§5-bis p.168). Un tetto che impedisce
   di CHIUDERE non è un limite di rischio, è un rischio. **Il freno resta il kill a −$100.**
   **⚠ UNA SOLA DEFINIZIONE**: `concentration.esposizioneMassimaRaggiungibileUsd(N)`, importata dai
   quattro chiamanti. `null` su N non leggibile — mai uno zero, che renderebbe l'invariante vera per
   qualunque cap. Verificato che morda: verde a $650 e $612,50, **rossa a $612,49, $400 e $306,25**, e
   rossa se N non si legge.
   **⚠ E `limiti-versionati` ⑥ CONTAVA SOLO IL RIPOSO**: relazione giusta, metà della grandezza.
   **⚠ `sette-punti` NON fotografa più il valore**: quel mestiere ce l'ha `limiti-versionati.test.js`,
   che confronta il versionato col disco chiave per chiave — una difesa che non vive nella memoria di
   chi ha scritto il numero. Due copie significavano solo che una sarebbe invecchiata, ed era
   invecchiata a $150 per un giorno.

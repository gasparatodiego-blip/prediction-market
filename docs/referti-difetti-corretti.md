# Referti dei difetti già corretti — il fatto, la misura, la diagnosi

**A cosa serve.** Ogni blocco qui è il referto **integrale** di un difetto **già corretto**: com'è
stato scoperto, quanto è costato, perché la cura è quella e non un'altra. In `CLAUDE.md` di quei
referti resta solo la **regola viva** che ne è uscita, con il rimando a questo file.
Testo **verbatim** dal `CLAUDE.md` prima della potatura del **23 agosto 2026**, con la sezione di
provenienza. **Niente è stato cancellato: è stato spostato.**

⚠ Un difetto **aperto** non sta qui: le questioni aperte restano in `CLAUDE.md` §5.2 per intero.

### §4.13 — il ripristino ricostruisce la coppia: il difetto dell'asimmetria (87,5 + 62,2 share ⇒ $67,17 contro un tetto di $61,25)

> **⚖ IL RIPRISTINO RICOSTRUISCE LA COPPIA, NON LA GAMBA — decisione dell'operatore.**
> `gambeDiUnaRiga` calcola `Q = capitale/(p_yes+p_no)`, cioè simmetrica **nell'istante in cui
> costruisce**, mentre la gamba superstite porta la size dell'istante in cui *fu piazzata*: la stessa
> formula a due istanti diversi, e **nessuno riportava la viva a oggi** (87,5 + 62,2 share ⇒ $67,17
> contro un tetto di $61,25). **La causa era l'ASIMMETRIA, non il tetto.** La cura
> (`lib/maker/coppia-simmetrica.js`, puro, zero `require`): una size per **entrambe**,
> `Q = min(Q_piano, Q_tetto, Q_gamba_viva)`, e nessuno dei tre può far CRESCERE niente.
> **⚠ `Q_gamba_viva` LA RENDE MONOTONA**: far crescere un ordine a riposo per «pareggiare» sarebbe
> aggiungere esposizione per ragioni di simmetria, e la simmetria si ottiene anche scendendo.
> **⚠ `Q_tetto` usa i prezzi VERI di ciò che resterà a libro**, e il tetto iniettato è
> `MARKET_CAP_FIXED_USD`, non `capPerMarketUsd`: qui non si pianifica, si dimostra che il gate non
> rifiuterà — e il gate confronta la costante.
> **⚠ SOTTO IL MINIMO PREMIANTE NON SI RICOSTRUISCE, e il tetto NON si allarga**: unico esito in cui il
> modulo dice «no» invece di «più piccolo».
> **⚠ L'ORDINE DELLE DUE AZIONI È PARTE DELLA CURA**: `nozionale-mercato-oltre-tetto` somma il nozionale
> a riposo ⇒ **prima si riduce, poi si piazza**; se la riduzione fallisce **non si piazza**, perché due
> gambe asimmetriche sono peggio di una sola. Il lucchetto copre entrambe le azioni, e **il prezzo della
> gamba viva non si tocca**. **⚠ LE DUE LETTURE DEVONO CONCORDARE**: lati diversi fra `v.mancanti` e gli
> ordini vivi ⇒ una delle due è vecchia ⇒ **nessuna azione**; gli ordini vivi si **passano**, non si
> rileggono. A verbale finiscono `coppia` (size, vincolo, totale, i tre `Q`) e `ridotte`.

### §4.13 — la copertura continua (ripristino-gambe): il numero 720 e le tre cose che non fa

> **🔁 LA COPERTURA CONTINUA RIMETTE LA GAMBA A LIBRO — §5-bis p.171.**
> **⚠ IL NUMERO CHE GOVERNA IL DISEGNO È 720**: il ciclo che ospita la decisione gira ogni **120 s**, e
> senza raffreddamento un mercato che rifiuta sempre verrebbe ritentato 720 volte al giorno.
> `lib/maker/ripristino-gambe.js` (puro) è una scala sui fallimenti **consecutivi**: subito · 5 · 10 · 20
> · **30 min di tetto**, azzerata quando il mercato torna `coperto`. Il primo tentativo è immediato
> perché la GTD è 23 min; il tetto sta **sopra** la GTD perché oltre quella soglia il problema non è più
> «manca la gamba» ma «questo mercato non si riesce a quotare», e la risposta è `da-sostituire`.
> **Contenimento provato coi numeri: 50 tentativi su 720 cicli, fattore 14,4×** — asserzione del test,
> non una frase in un commento. **⚠ Si azzera su `coperto` OSSERVATO, non su un invio accettato.**
> **LE TRE COSE CHE NON FA**: ① non è una seconda strada verso il venue — riga dal piano **già salvato**
> → `gambeDiUnaRiga` → `piazzaCoppia`, cioè lo stesso `runBulkAllocation` con lo stesso freno e gli
> stessi gate; ② **non ricostruisce il piano**; ③ **non abilita niente**. **E UNA CHE FA**: scrive
> **sempre** a verbale (`tipo: 'ripristino-gamba'`), anche quando non tenta — un presidio che non lascia
> traccia non è verificabile.
> **⚠ SI PIAZZA UNA GAMBA SOLA DI PROPOSITO, e non contraddice §4.6**: l'altra gamba **è già a libro** —
> è la definizione di `da-coprire` — e il precontrollo atomico vive dentro `if (accoppiato)`.
> **⚠ Trappola**: `gambeDiUnaRiga` produce righe con `book` e **senza `tokenId`** mentre
> `valutaCopertura` risponde in **token** (serve una traduzione esplicita, fail-closed), e `LOCK.stato()`
> restituisce **`id`**, non `conditionId`.

### §4.6 — il pavimento della scala dev'essere un prezzo esprimibile: le 147 righe OFF_TICK (22 agosto 2026)

> **📐 IL PAVIMENTO DELLA SCALA DEV'ESSERE UN PREZZO ESPRIMIBILE — 22 agosto 2026.**
> `pavimentoConcesso` è una frazione del carico (il 5%, R7) e non cade quasi mai su un tick:
> `0,68 × 0,95 = 0,646`, `0,37 × 0,95 = 0,3515`. `auto-close.inseguiIlBid` lo usa come `Math.max`,
> quindi appena il bid scende sotto il pavimento il **prezzo dell'ordine diventa il pavimento**, e il
> guard condiviso lo rifiuta con **`OFF_TICK`**. Misurato sul giornale vivo: **147 righe** con
> `OFF_TICK` — **25** `skip-guard-refused` a 0,646 su `0x4757745c` (22/08 17:47→18:14), **107** e **15**
> `skip-remainder-below-min-size` con codici `OFF_TICK,BELOW_MIN_SIZE` su `0xac3ee338` e `0x70620889`
> (20-21/08, carico 0,37), dove la deroga sul minimo del venue **non si applica proprio perché** c'è
> anche OFF_TICK.
> **LA CURA**: `pavimentoConcesso` restituisce **due numeri** — `pavimento` (esatto, serve a
> **confrontare**) e `pavimentoGriglia` (sulla griglia del mercato, serve a **prezzare**).
> **⚠ UN SOLO ARROTONDAMENTO IN TUTTO IL REPO**, e sta lì: nato dentro il solo ramo fuori banda era
> metà della correzione, e la metà che non serviva ai 132 rifiuti veri. `exit-plan` **legge**
> `pav.pavimentoGriglia`, non lo ricalcola — un test conta gli arrotondamenti e pretende che sia **uno**.
> **⚠ IN SU, E LA DIREZIONE È OBBLIGATA**: in giù si venderebbe **sotto** il pavimento della scala del
> §7. In su se ne concede **meno**: il tappo del 5% non si sposta, può solo stringersi sulla griglia.
> **⚠ IL CONFRONTO RESTA SUL NUMERO ESATTO**: spostarlo cambierebbe chi passa e chi no (il ramo
> «pareggio non basta»), che è una decisione di rischio e non un arrotondamento. Le due cose non
> possono contraddirsi: `b.hi` sta già sulla griglia, quindi `b.hi ≥ pavimento ⇒ b.hi ≥ pavimentoGriglia`
> — l'arrotondamento **non può** spingere il prezzo fuori banda. Asserito su 500+ piani, non promesso.
> **⚠ VALE ANCHE SENZA CONCESSIONE**: il pavimento a gradino 0/1 **è il carico**, che è un prezzo
> **medio di fill** e cade fuori griglia più spesso di una frazione (0,6733 non è un prezzo).
> **⚠ SU UN TOKEN ECONOMICO IL PAVIMENTO PUÒ FINIRE SOPRA IL CARICO** (0,095 ⇒ 0,09025 ⇒ **0,10**): è la
> conseguenza onesta di una griglia da 1¢ su 9,5¢ — `tickConcessi` diceva già **0**. Prima quel caso
> produceva un rifiuto, adesso un ordine valido.

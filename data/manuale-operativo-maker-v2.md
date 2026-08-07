# Manuale operativo dei maker vincenti — v2: la statistica su 21 esemplari

Allargamento del campione del [manuale v1](manuale-operativo-maker.md) da 4 a **21 wallet**, stessa
pipeline e stessa metodologia. Finestra **90 giorni uguale per tutti**, chiusa il 7 agosto 2026.
Solo letture pubbliche.

Raccolti: **269 wallet screenati**, 21 analizzati a fondo, **~40.000 fill**, 18.692 nuovi mercati con
metadati Gamma, 1.870 serie di prezzo al minuto.

---

## Prima di tutto: una correzione che invalida il numero principale del v1

Il v1 pubblicava «$2,4–$14,6 al giorno per ogni $1.000 di capitale» e ci concludeva sopra che
$30/giorno con $620 non è raggiungibile. **Quel calcolo misura la cosa sbagliata, e va ritirato.**

I reward di Polymarket **non si pagano sui fill: si pagano sugli ordini FERMI nel libro**, campionati
con uno snapshot al minuto. Il punteggio dipende da quanta size hai a riposo, quanto vicina al mid e
per quanti minuti — non da quanto ti viene eseguito. La documentazione è esplicita
([Liquidity Rewards](https://docs.polymarket.com/market-makers/liquidity-rewards)).

Ne segue che **nessun endpoint pubblico vede il capitale che genera i reward**:

| misura | cosa vede | cosa manca |
|---|---|---|
| `/value` | posizioni aperte adesso | tutto ciò che è già ruotato |
| ricostruzione dai fill (v1 e v2) | capitale che è **diventato posizione** | gli ordini a riposo mai eseguiti |
| **quello che paga** | **profondità a riposo, campionata al minuto** | **non osservabile** |

Un maker che tiene $500 per lato su venti mercati ha $20.000 impegnati nel libro e può farsi eseguire
$300. Entrambe le nostre misure vedono $300.

**Conseguenza operativa:** in questo documento non c'è nessun «rendimento per $1.000», perché non è
calcolabile. Il rapporto reward / capitale-eseguito resta in tabella come indicatore di *efficienza
del ciclo* — quanto reward per dollaro che passa davvero di mano — ed è utile per ordinare i wallet,
ma **non è un rendimento sul capitale e non va usato per dimensionare il nostro.**

Quello che invece è misurato bene, su tutti e 21, è il **comportamento**: cosa scelgono, dove si
mettono, quanto grande, quando smettono. È il contenuto di questo manuale.

---

## Fase 1 — la selezione

Fascia reward cumulativi **$3.000–$40.000** del `top1000.json`: 895 wallet, esclusi i 4 già
analizzati. Filtri, in ordine dal più economico al più caro:

1. ultimo trade ≤ 5 giorni
2. ≥ 5 fill/giorno
3. **scadenza mediana dei mercati al primo fill ≤ 2 giorni** ← il criterio nuovo
4. bilanciato (BUY/SELL 0,6–1,4) **oppure** redeem-dominante
5. nessun filtro sul `/value`

**269 screenati, 17 trovati (6,3%).** Il v1, che filtrava sul `/value` e non sulla scadenza, ne
trovava 3 su 864 (0,35%): il criterio giusto vale diciotto volte quello sbagliato.

| motivo di scarto | n |
|---|---|
| fermo da oltre 5 giorni | 125 |
| **mercati troppo lunghi (> 2 giorni)** | **75** |
| meno di 5 fill/giorno | 35 |
| né bilanciato né redeem-dominante | 14 |
| conversioni neg-risk non osservabili | 1 |
| scadenze non leggibili / nessun fill | 2 |

L'unico escluso come non confrontabile è **badatthis** (87% di vendite scoperte, zero redeem): lo
stesso schema di 0xF0e02A54, che il v1 aveva già segnalato.

---

## Fase 3 — le distribuzioni

Su tutti e 21 per i parametri di comportamento; su **15** per quelli che dipendono dalla
ricostruzione del capitale (sei esclusi, motivi in fondo).

| parametro | min | Q1 | **mediana** | Q3 | max |
|---|---|---|---|---|---|
| **Scadenza al primo fill** (giorni) | −0,08 | 0,18 | **0,44** | 0,80 | 59,8 |
| **Nozionale per fill** ($) | 2,73 | 15,90 | **33,97** | 74,41 | 829,56 |
| **Size per fill** (share) | 20 | 45 | **77** | 200 | 998 |
| **Distanza dal mid, BUY** (¢) | 0,10 | 0,50 | **1,50** | 2,13 | 25,25 |
| **Distanza dal mid, SELL** (¢) | 0,10 | 0,50 | **0,88** | 1,30 | 15,50 |
| **Frazione della banda** | 0,014 | 0,20 | **0,333** | 0,419 | 7,06 |
| **Banda del mercato** (¢) | 2,5 | 4,5 | **4,5** | 4,5 | 4,5 |
| **Montepremi del mercato** ($/g) | 0 | 10 | **47** | 300 | 5.083 |
| **Mercati toccati** (90 g) | 181 | 505 | **876** | 1.636 | 5.231 |
| **Nuovi mercati al giorno** | 3 | 5,5 | **10** | 13 | 137 |
| **Mercati contemporanei** | 3,5 | 6 | **10** | 22 | 152 |
| **Fill al giorno** | 4,1 | 8,9 | **18,6** | 39,6 | 376 |
| **Ore attive su 24** | 7 | 16 | **17** | 20 | 24 |
| **Chiusura a redeem** (%) | 21,7 | 76,4 | **94,1** | 98,7 | 100 |
| **Chiusura a vendita** (%) | 0 | 0,3 | **3,9** | 17,3 | 78,3 |
| **Ultimo fill prima della risoluzione** (h) | 0,01 | 4,53 | **10,65** | 22,03 | 1.423 |
| **BUY/SELL** | 0,03 | 0,64 | **1,17** | 2,43 | 65,2 |
| **Reward al giorno** ($) | 0,0 | 8,46 | **64,42** | 113,41 | 151,89 |
| Capitale *eseguito*, picco giornaliero ($) | 106 | 1.018 | **4.241** | 13.940 | 70.745 |
| Rotazione sul capitale eseguito (90 g) | 2,8 | 6,8 | **15,9** | 33,9 | 1.204 |

### Cosa conferma e cosa smentisce il v1

**Confermato, e ora con una distribuzione dietro:**
- La scadenza brevissima. Mediana **0,44 giorni**, Q3 0,80. Il v1 diceva 0,26–0,63 su tre punti.
- Il nozionale piccolo. Mediana **$34**, Q1–Q3 $16–74. Il v1 diceva $28–47.
- La distanza dal mid. Mediana **0,88–1,50¢**, cioè il **33% della banda**. Il v1 diceva 0,5–1,5¢ e
  20–35%: identico.
- La banda: **4,5¢ per il 75% del campione**, praticamente una costante del venue.

**Smentito o corretto:**
- **Il redeem è molto più dominante di quanto sembrasse**: mediana **94,1%**, non 74%. La vendita è
  la chiusura di una minoranza (mediana 3,9%). *Lasciar risolvere non è una preferenza: è la norma.*
- **Il merge è molto più diffuso**: 12 wallet su 21 ne fanno, uno (superstonksbro) 1.155 in 90
  giorni. Il v1, su 4 punti, lo dava come eccentricità di Nopants.
- **«12–18 mercati contemporanei» era troppo alto** — vedi la sezione correlazioni.

### Il parametro nuovo: quando smettono di farsi riempire

Mediana **10,65 ore prima della risoluzione**, Q1 4,5 h. Non restano in banda fino all'ultimo minuto:
l'ultimo fill arriva mezza giornata prima che il mercato chiuda. Chi ci resta fino in fondo lo fa di
mestiere (LondonBridge 0,06 h, gcmcrb 0,01 h — entrambi sui mercati crypto a 5 minuti, dove *tutto*
succede negli ultimi minuti).

---

## Le correlazioni — e il loro limite

Correlazione di rango (Spearman) fra ciascun parametro e il **reward per $1.000 di capitale
eseguito**, su n=15. Con quindici punti niente qui è una prova; sono indizi ordinati per forza.

| ρ | parametro | lettura |
|---|---|---|
| **−0,58** | capitale eseguito | i piccoli rendono di più per dollaro |
| **−0,51** | nuovi mercati al giorno | **più mercati ≠ più resa** |
| **−0,47** | mercati toccati | idem |
| **−0,46** | mercati contemporanei | idem |
| **+0,46** | % chiusure a vendita | chi vende invece di aspettare rende di più |
| **+0,34** | montepremi del mercato | la selezione sul premio paga, debolmente |
| −0,35 | BUY/SELL | gli sbilanciati verso l'acquisto rendono meno |
| −0,32 | banda del mercato | bande strette leggermente meglio |
| −0,18 | distanza dal mid, BUY | |
| −0,15 | rotazione | |
| **+0,07** | **scadenza mediana** | **nessun segnale** |
| −0,02 | distanza dal mid, SELL | |

**Il ρ ≈ 0 sulla scadenza non dice che la scadenza non conta: dice che nel campione non varia**,
perché l'ho usata come filtro di selezione (≤ 2 giorni). È restrizione di campo, e va letta così. Il
confronto che conta sulla scadenza è fra questo campione e noi, non dentro il campione.

**Il segnale più utile è il primo, ed è controintuitivo rispetto al v1:** i tre parametri di *scala*
(quanti mercati, quanti contemporanei, quanto capitale) sono tutti **negativamente** correlati con la
resa per dollaro. Chi si allarga peggiora l'efficienza. Il v1 raccomandava di passare da 4–6 a 12–18
mercati contemporanei; **su 21 esemplari quella raccomandazione non regge**, e la mediana è 10.

---

## Il setting consensus

Per ogni parametro del motore: il valore mediano del campione, e la proposta per i nostri $620.

| Parametro | Consensus (mediana) | Intervallo utile (Q1–Q3) | Nostro oggi | **Proposto** |
|---|---|---|---|---|
| Distanza dal mid, BUY | 1,5¢ | 0,5–2,1¢ | `OFFSET_TICKS=1` | **invariato** ✔ |
| Distanza dal mid, SELL | 0,88¢ | 0,5–1,3¢ | idem | **invariato** ✔ |
| Frazione della banda | 0,33 | 0,20–0,42 | non misurata | **quotare al 20–40% della banda** |
| Nozionale per ordine | $34 | $16–74 | ~$100+ | **$30–40** |
| Size per ordine | 77 share | 45–200 | — | **60–90**, ≥ `rewardsMinSize` |
| Mercati contemporanei | 10 | 6–22 | 4–6 | **8–10**, non di più |
| Nuovi mercati al giorno | 10 | 5,5–13 | ~0,3 | **5–8** |
| Fill al giorno | 18,6 | 8,9–39,6 | ~2 | conseguenza dei precedenti |
| **Scadenza al primo fill** | **0,44 g** | **0,18–0,80 g** | **12–24 g** | **< 24 ore** |
| Montepremi minimo | $47/g | $10–300 | non filtrato | **≥ $25/g**, preferire ≥ $100 |
| Banda | 4,5¢ | 4,5 ovunque | non filtrata | **non è un criterio** |
| Ore operative | 17 | 16–20 | 24 (bot) | **invariato** ✔ |
| Chiusura | **redeem 94%** | 76–99% | auto-close | **lasciar risolvere** |
| Uscita anticipata | 10,65 h prima | 4,5–22 h | — | **smettere di rinnovare ~6 h prima** |
| BUY/SELL | 1,17 | 0,64–2,43 | — | non vincolare |
| Merge | 12 wallet su 21 | coppia ~99¢ | **eseguibile, spento** (`CTF_RELAYER_ENABLED`) | **opzionale**, soglia 99/100,5 confermata |

> **Il merge non è più teorico — nota del 7 agosto 2026.**
>
> Fino a stamattina questa riga diceva «costruito, spento», e dietro c'era una conclusione più dura:
> il merge on-chain era ritenuto **non eseguibile** dal nostro stack. Le ragioni erano quattro e
> nessuna campata in aria — nessun percorso di scrittura on-chain in tutto il repo, i token nel
> funder-contratto e non nell'EOA che firma, il funder senza MATIC per il gas, e il deposit wallet
> ERC-1271 la cui interfaccia non era nel nostro stack.
>
> Il **relayer gasless** di Polymarket ne toglie tre: paga lui il gas, e fa eseguire al deposit
> wallet un batch firmato dal suo owner. La quarta l'abbiamo scritta noi: `lib/maker/ctf-relayer.js`.
>
> **Provato per davvero**, su Schwartzel FL-19 (`negRisk=true`, il caso più difficile perché passa dal
> NegRiskAdapter e le posizioni vivono su `WrappedCollateral`, non su pUSD):
>
> | | tx | blocco | pUSD |
> |---|---|---|---|
> | split $2 | `0x96072ab7…143a` | 91619080 | 590,264868 → 588,264868 |
> | merge $2 | `0x792b31e5…76a8` | 91619511 | 588,264868 → **590,264868** |
>
> Saldo tornato alla cifra esatta di partenza, esposizione netta zero, gas pagato dal relayer in
> entrambi i casi. L'ordine manuale a riposo sul venue non è stato toccato.
>
> **Attenzione a non confondere due interruttori diversi**, perché governano cose diverse:
>
> - `CTF_RELAYER_ENABLED` — in `lib/maker/ctf-relayer.js`, è una **costante nel sorgente, non una
>   variabile d'ambiente**: si accende modificando il file e ricostruendo. Decide se il *meccanismo*
>   può firmare e inviare. È **`false`**, rimesso a false a prova finita.
> - `MERGE_STRATEGY_ENABLED` — in `lib/maker/strategia-merge.js`. Decide se la *strategia* completa le
>   coppie dopo un fill. È **`false`**, e per una ragione che resta valida: comprare il secondo lato
>   immobilizza capitale nuovo, ed è una scelta dell'operatore, non una conseguenza del fatto che
>   adesso il merge si può fare.
>
> Accendere il primo non accende il secondo. Nessun agent, route o scheduler importa `ctf-relayer`:
> l'unico file che ne fa `require` è il suo test, quindi con l'interruttore acceso non parte nulla da
> solo — toglie il freno a una chiamata fatta a mano, e a nient'altro.
>
> **Una trappola operativa da ricordare:** il relayer rifiuta le deadline corte con `400 deadline too
> soon`. `DEADLINE_SEC` era 240s «il valore raccomandato dall'SDK di riferimento» e il primo merge è
> stato respinto — mentre lo split di quattro minuti prima era passato con la *stessa* deadline. La
> soglia non è documentata e non è osservabile senza inviare. Ora è **900s**.

### E il capitale?

**Non lo so, e nessuno può saperlo dai dati pubblici** — è il punto in cima a questo documento. Quello
che si può dire:

- I quattro con l'efficienza di ciclo più alta (jjjjjsda, Nopants, wesquezz, Flashwhisky) hanno un
  capitale *eseguito* di picco fra **$483 e $1.233** — la nostra taglia — e incassano **$60–$113 al
  giorno** di reward.
- Ma la loro profondità a riposo può essere molte volte tanto, e non la vediamo.

Quindi: **$30/giorno non è né provato né smentito.** Il v1 lo dichiarava irraggiungibile su un
calcolo che ora so essere mal posto. La risposta onesta è che il tetto dipende da quanta profondità
possiamo tenere ferma in banda, e quel numero lo conosciamo solo noi, dal nostro lato.

**Il modo per scoprirlo è misurarlo su di noi**, non stimarlo su di loro: con il setting consensus
attivo, il rapporto fra reward incassato e profondità media a riposo è direttamente osservabile dai
nostri log. È l'unica misura di rendimento che non richiede di indovinare.

---

## Gli outlier istruttivi

**Chi rende di più per dollaro eseguito**

- **jjjjjsda** — $113/giorno, picco eseguito $817, 8 nuovi mercati/giorno, nozionale $18, 130 merge.
  È l'unico dei primi quattro che chiude a vendita quasi quanto a redeem (49% redeem): il ρ +0,46
  sulla vendita è in larga parte lui.
- **Nopants** — 3 nuovi mercati al giorno, il minimo del campione. Fa **poco e bene**: nozionale $24,
  85% redeem, 109 merge a coppia mediana 99,53¢.
- **wesquezz** — l'unico che lavora **tutti i giorni** e sceglie i premi grossi ($225/g mediano) su
  mercati a 6 ore. Esport al 65%.
- **Flashwhisky** — nozionale $11, il più piccolo fra i buoni, 96% redeem, 5 nuovi mercati/giorno.

Il loro tratto comune non è la scala: è **la selettività**. 3–12 nuovi mercati al giorno contro i
13–137 di chi sta in fondo.

**Chi rende meno, e perché**

- **superstonksbro** — 28 nuovi mercati/giorno, **1.155 merge**, ma solo **7 ore attive su 24** e
  $70.745 di picco eseguito. Molto capitale, poche ore in banda: paga il tempo, non il volume.
- **7zhfr68nhf568jgr346j** — nozionale **$2,73**, il minimo assoluto, con 16,5 nuovi mercati al
  giorno. Ordini così piccoli difficilmente superano `rewardsMinSize`: presenza senza qualificazione.
- **Anon** — distanza dal mid **25¢ in BUY e 15,5¢ in SELL**, cioè fuori banda quasi sempre. Il 99%
  a redeem: non fa il maker, accumula.
- **NovaB** — nozionale **$830** per fill su 4 mercati/giorno. L'opposto esatto del consensus, e sta
  in fondo.

**La lezione degli outlier è simmetrica**: si perde efficienza sia allargandosi troppo
(superstonksbro, 28 mercati/giorno) sia concentrandosi troppo (NovaB, $830 per fill). Il centro —
5–10 mercati nuovi al giorno da $30 — è dove stanno tutti i buoni.

---

## Dove siamo più lontani — lista priorità aggiornata

1. **Scadenza dei mercati: 12–24 giorni contro una mediana di 0,44.** Invariato dal v1, e ora con
   Q1–Q3 0,18–0,80 su 21 esemplari. Resta il divario numero uno.
2. **Nuovi mercati al giorno: ~0,3 contro 10** (Q1 5,5). Conseguenza del punto 1.
3. **Selezione sul montepremi: assente.** Mediana $47/giorno, Q3 $300. Il filtro più economico da
   aggiungere, e uno dei pochi con correlazione positiva (+0,34).
4. **Taglia dell'ordine: ~$100 contro $34.**
5. **Chiusura: auto-close contro redeem al 94%.**

**Cambiato rispetto al v1:** i mercati contemporanei salgono da 4–6 a **8–10**, non a 12–18. La
correlazione negativa con la resa dice che allargarsi oltre la mediana peggiora le cose.

**Confermato che non va toccato:** la distanza dal mid (siamo già a 1 tick ≈ 0,5–1,0¢, dentro
Q1–Q3), le ore operative, la banda.

---

## Limiti di metodo

1. **Il capitale che genera i reward non è osservabile** (sezione in cima). Tutti i numeri di
   capitale qui dentro sono capitale *eseguito*, un limite inferiore di quello impegnato. Nessun
   «rendimento» è pubblicato.
2. **Sei wallet su 21 hanno la ricostruzione del capitale esclusa**, con il motivo: M1XU (15% di
   scadenze valide), Lilybaeum (41%), NovaB (54%), Unknown (65%) — Gamma riporta una `endDate`
   anteriore ai fill su mercati ricorrenti; 0xF0e02A54 e gcmcrb (picco ricostruito nullo). Restano
   nel campione per i parametri di comportamento, esclusi dalle statistiche di capitale e dalle
   correlazioni.
3. **Le correlazioni sono su n=15.** Nessun test di significatività: con quindici punti sarebbe
   teatro. Vanno lette come ordinamento di indizi.
4. **Restrizione di campo sulla scadenza**: è un criterio di selezione, quindi il suo ρ ≈ 0 è un
   artefatto del disegno, non un risultato.
5. **La distanza dal mid usa `prices-history`, che è l'ultimo scambiato, non il book.** Misurata sul
   punto ad **almeno 120 s prima** del fill per non leggere il fill stesso. La magnitudine è solida,
   **il segno no**.
6. **Il campione della distanza dal mid è parziale**: 110 token per wallet (i 70 più attivi più 40
   sistematici sul resto), finestre spezzate a grappoli di 4 ore perché l'endpoint rifiuta oltre
   ~72 ore.
7. **Il rodaggio**: la ricostruzione parte da zero all'inizio della finestra e ignora l'inventario
   preesistente. I primi 7 giorni della curva sono scartati. Con scadenza mediana sotto il giorno il
   residuo è piccolo, ma non è zero.
8. **L'affollamento è misurato solo sui 4 wallet del v1** (30 mercati ciascuno) e conta i wallet
   distinti nei primi 500 trade: include i taker, quindi è un limite superiore.
9. **Le categorie sono dedotte da titolo ed eventSlug** con parole chiave: «altro» resta fra il 7% e
   il 40%.
10. **Finestra 90 giorni per tutti**, chiusa il 7 agosto 2026. I quattro del v1 sono stati
    ricalcolati su questa finestra, quindi i loro numeri qui **non coincidono** con quelli del v1,
    che era a 360 giorni.

# D-D — il riferimento del guardiano non nasceva da un capitale che sia mai esistito

**21 agosto 2026.** Sola lettura per la diagnosi; la correzione tocca `lib/maker/guardian-riferimento.js`
e il cablaggio in `agents/agent43-guardian.js`. Nessun ordine toccato, nessun processo riavviato senza
autorizzazione.

## 1 · La causa, e non è una soglia stretta

`data/guardian-baseline.json` porta `riferimentoUsd: 1550.17633`, fissato il **16/08 alle 19:28:00.990Z**
con `motivo: "nuovo massimo $1550.18"`. Quel totale non è mai esistito. I campioni dell'osservatore
intorno a quell'istante:

| ora | saldo | posizioni | n | totale |
|---|---|---|---|---|
| 19:27:17 | $1.439,94 | $57,103 | 3 | **$1.497,05** |
| **19:28:00 (guardiano)** | **$1.493,07** | **$57,103** | — | **$1.550,18** ← il massimo |
| 19:28:18 | $1.493,07 | $0,003 | 1 | **$1.493,08** |

Il saldo è quello **dopo** la chiusura delle posizioni, le posizioni sono quelle **prima**: gli stessi
**$57,10 contati due volte**. Lo scarto fra il massimo e il totale vero è $57,10 esatti — il valore delle
posizioni. Non è una deduzione, è un'identità aritmetica.

**L'asimmetria che lo ha reso permanente.** Lo SCATTO pretende due letture distinte e contigue
(`confermaScatto`, k=2), perché — lo dice l'intestazione di `guardian-perdite` — il segnale è più rumoroso
della soglia: salti fino a **$74,47** fra letture a 30 s, che rientrano al campione dopo. Il CRICCHETTO
accettava lo stesso segnale con **k=1**. E l'errore non è simmetrico nel tempo: un transitorio verso il
basso rientra e sparisce, uno verso l'alto **resta per sempre**, perché un massimo mobile non scende.

**Erano due strade, non una.** A posizioni ferme — anche quando sono ferme solo perché lo snapshot non è
stato riletto — un salto del solo saldo soddisfa pure `rilevaMovimentoEsterno`, che spostava il
riferimento verso l'alto per conto suo. Chiuderne una sola non sarebbe bastato.

## 2 · Il costo, misurato

- Il riferimento fantasma si è mangiato **3,5-3,8% dei 5%** di budget di drawdown **in permanenza**: dal
  17/08 al 21/08 il PnL «a riposo» oscillava fra −$54,92 e −$59,41 senza che nulla fosse andato storto.
- **4 pre-allarmi e 1 SCATTO** (20/08 22:36:02, PnL −$111,77), che ha cancellato gli ordini e messo il
  bot su **FERMA per 6h06m** — riacceso a mano alle 04:42:39Z del 21/08.
- Margine residuo al momento della diagnosi: **$22,12**, contro escursioni giornaliere **vere** di
  $32,05 (20/08) e $38,12 (21/08).

⚠ **Il massimo «confermato» che l'osservatore mostra a occhio è a sua volta un fantasma**: il picco
grezzo di $1.530,06 (19/08 00:20) è lo stesso artefatto — saldo +$36,78 con posizioni stantie a $38,70,
azzerate al campione dopo. Su 8.812 campioni i picchi a **una sola lettura** sono **4**, e sono quelli che
producono le escursioni apparenti: il 19/08 l'escursione scende da **$38,70 a $1,92** una volta tolto il
picco. Il massimo davvero sostenuto da due letture consecutive è **$1.501,63** (16/08 15:22).

## 3 · La regola nuova

**Il riferimento scende subito, sale solo su conferma.**

- Un totale sopra il riferimento diventa un **CANDIDATO**. Il riferimento sale solo quando una seconda
  lettura **distinta e contigua** (≤ 120 s, la stessa costante dello scatto, **importata**) sta anch'essa
  sopra, e sale al **minimo delle due** — il livello che entrambe sostengono, non la punta.
- Un totale che rientra sotto il riferimento **azzera il candidato**: non è persistito, non era capitale.
- «Distinta» è la stessa domanda di `confermaScatto` e per la stessa ragione (`SALDO_CACHE_TTL_MS` 45 s >
  giro 30 s ⇒ due giri possono leggere la stessa voce di cache): basta che i due totali differiscano; a
  parità di totale si pretende un istante di lettura del saldo diverso. Non leggibile ⇒ **non si conferma**.
- Un movimento di cassa **negativo** (prelievo) abbassa il riferimento all'istante, come prima. Uno
  **positivo** (deposito) non passa più di lì: alza il totale, quindi lo assorbe il massimo mobile —
  con la conferma. Nel giro d'attesa il PnL è positivo, e un PnL positivo non ha mai fatto scattare niente.

⚠ **Non può far scattare prima, per costruzione**: si scatta quando `tot ≤ 0,95 · rif`, e un riferimento
che sale più lentamente può solo **abbassare** il punto di scatto. La correzione toglie scatti, non ne
aggiunge — il che significa che **allenta** la difesa di **$46,12** sul punto di scatto
($1.472,67 → $1.426,55). È il verso voluto: quei $46,12 erano un fantasma.

⚠ **L'unica eccezione dichiarata**: la primissima lettura in assoluto **crea** il riferimento senza
conferma, perché non c'è niente contro cui confermarla. Succede una volta, o quando l'operatore cancella
il file a mano.

## 4 · La simulazione a secco

`node scripts/ricerca/d-d-riferimento-guardiano.js` → `data/ricerca/d-d-riferimento-21-agosto.json`.
La funzione **vera** girata su **8.812 campioni reali** (15/08 12:52 → 21/08 18:32) alza il riferimento
**3 volte in 6,2 giorni**, tutte confermate, e finisce a **$1.501,63** — lo stesso numero che dà il
calcolo indipendente del «massimo sostenuto da due letture». Due metodi diversi, stesso valore.

| | vecchio | nuovo |
|---|---|---|
| riferimento | $1.550,18 | **$1.501,63** |
| soglia (5%, invariata) | $77,51 | $75,08 |
| punto di scatto | $1.472,67 | $1.426,55 |
| drawdown su $1.494,78 | −$55,39 (−3,573%) | **−$6,85 (−0,456%)** |
| **margine** | **$22,12** | **$68,23** (3,08×) |

**Replay sulle 10.711 letture VERE del guardiano** (log di agent43, **4,01 giorni** — non 7: il log parte
dal riavvio della flotta del 17/08 18:19, prima non esiste nulla):

| | pre-allarmi | scatti |
|---|---|---|
| riferimento vecchio | **4** | **1** — 20/08 22:36:02, tot $1.438,41, PnL −$111,77 |
| riferimento nuovo | **0** | **0** |

Il replay riproduce lo scatto vero riga per riga (stessa ora, stesso PnL): è la prova che il modello del
replay è fedele, non una simulazione a parte.

**Lo scatto del 20/08 22:36 NON avverrebbe**: PnL −$63,22 contro una soglia di −$75,08, **margine residuo
$11,86**. Il bot sarebbe rimasto a libro invece di fermarsi per 6h06m.

⚠ **Il drawdown va a quasi zero di colpo, ed è l'effetto atteso**: −$55,39 → −$6,85. Non è capitale
recuperato, è un drawdown che non c'era.

## 5 · La soglia resta al 5%, e perché

Non è stata toccata. Il difetto era il riferimento, non la soglia: le escursioni giornaliere **vere**
(ripulite dai 4 picchi a un campione) sono $0,01 · $12,92 · $0,00 · $5,37 · **$1,92** · $32,05 · $38,12,
e contro un margine di $68,23 la peggiore lascia **$30,11**. Alzare la soglia per coprire un artefatto di
misura sarebbe stato allargare un limite di rischio invece di correggere un difetto.

⚠ **«Non sarebbe mai scattata» va dichiarato, e non vuol dire inerte.** Nella finestra di 4,01 giorni con
il riferimento nuovo gli scatti sono **zero**. Ma la lettura più bassa mai vista ($1.438,41 — a sua volta
un artefatto verso il basso) resta a **$11,86** dal punto di scatto, e il minimo **vero** misurato
($1.459,80, 21/08) a $33,25. Il guardiano è a una brutta giornata dallo scattare, non fuori servizio.

## 6 · Il riarmo resta MANUALE — proposta, non implementata

**Non implemento un riarmo automatico di AVVIA**, per tre ragioni:

1. Sarebbe una **terza strada autonoma verso il capitale reale**: §2 regola 3 ne nomina due (agent41 e le
   cancellazioni di agent43), e questa nascerebbe dentro il modulo il cui mestiere è **fermare**.
2. Dopo la correzione, gli scatti nella finestra osservabile sono **zero**: un riarmo automatico sarebbe
   una cintura senza chiamanti — la cosa che §4.14 condanna esplicitamente.
3. Uno scatto che sopravvive al riferimento corretto è un drawdown **vero del 5%**. Riaccendere dentro
   quella discesa è esattamente il modo di sbagliare che l'operatore ha nominato.

Resta com'è la scadenza del latch (24 h **e** PnL rientrato ⇒ torna in servizio il **guardiano**, non il
bot: `valutaLatch`).

**Quello che invece va aggiunto è l'allarme, e il costo misurato dice perché**: le 6h06m di fermo non sono
costate perché il riarmo è manuale, sono costate perché **nessuno sapeva**. Il canale esiste già ed è
provato — `api.telegram.org/bot<token>/sendMessage`, usato da `agent27-news-guard:163`,
`agent38-tape-watchdog` e `agent-monitor` — e va acceso **solo sul ramo dello scatto**, best-effort, mai
in modo che possa ritardare la spazzata.

⚠ **Manca la configurazione, e non posso metterla io**: `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` **non
sono nel `.env`** (agent27 le legge e senza di esse logga soltanto). Servono due chiavi dall'operatore, e
§2 regola 1 vieta di toccare `.env` senza istruzione esplicita. **Decisione dell'operatore**, non della
patch.

## 7 · Cosa NON è stato toccato

Distanza (0.456), QUOTA_CODA_LUNGA, MERCATI=5, cancello 24 h, tetto per mercato, cap per ordine, cap di
esposizione, tetto coppia, pavimento di profondità, SLOT_STERILE, `bestObiettivoPerDay`, tetto del board.
E la **soglia**: 5%, invariata.

**Il guardiano mark-to-market non dipende dal ledger** — verificato sugli import: legge `leggiSaldoUsd`
(cassa) e `readVenuePositions` (snapshot del venue), e nient'altro. La cecità del ledger vive in
`kill-perdita-giornaliera`, che è il **secondo** ingresso (la perdita giornaliera realizzata a −$100), non
questo. La difesa viva resta indipendente.

**Nessun percorso di questa correzione tocca ordini a libro.** `aggiornaRiferimento` è puro e il suo albero
dei `require` è di **2 file**, nessuno dei quali è una superficie di piazzamento o cancellazione (asserito
dal test, blocco ⑦). L'unica superficie di agent43 resta la spazzata, che parte solo su uno scatto — e la
correzione può solo **ridurre** gli scatti.

## 8 · Prove

- `lib/maker/guardian-riferimento-non-supera-il-confermato.test.js` — **26/0**. Morde sul comportamento:
  data una serie qualunque, il riferimento non può superare il massimo che **due letture consecutive**
  sostengono. Sul sorgente NON corretto è **11 rosse su 26**, e la prima riproduce il valore di
  produzione: **$1.550,17933** dai numeri veri del 16 agosto.
- `lib/maker/guardian-riferimento.test.js` — **32/0**. Due blocchi (② deposito, ⑥ massimo mobile) sono
  stati **RISCRITTI non ammorbiditi**: difendevano «una lettura sola alza il massimo», che era la
  proprietà vera fino al 20 agosto e il difetto dal 16. Sul sorgente vecchio la versione nuova è 7 rossa.
- `lib/maker/guardian-perdite.test.js` — **68/0**, invariato.
- Suite completa: **242 test · 233 verdi · 8 ROSSI · 1 non parte**. Nessun rosso introdotto: verificato
  mettendo da parte le modifiche e rieseguendo. ⚠ La composizione degli 8 è **cambiata da sola**:
  `tre-fix-sicurezza` è rientrato (era un timeout, §5.2 p.42) e `allowlist-con-posizioni` è uscito rosso —
  **rosso anche su HEAD senza le mie modifiche**, 15/2 in entrambi i casi.

# I concorrenti davvero affini — 12 agosto 2026

**SOLA LETTURA.** Nessun ordine, nessun riavvio, nessuna modifica al codice operativo. KILL attivo,
bot FERMO, freno di prova inserito per tutta la durata.

Rifacibile con `node scripts/wallet-affini.js --pagine 6`; dati grezzi in `docs/wallet-affini-dati.json`.

---

## 0 · Il filtro è a monte, e questa volta serve davvero

L'errore da non ripetere: prendere wallet da una classifica e scoprire dopo che il 91% della loro
attività era spread capture sportivo. Qui si misura **l'intera attività pubblica** di ogni candidato
*prima* di guardare come opera.

**Criterio di ammissione — entrambe le condizioni, congiunte:**

1. **> 50% dei mercati con trade ha montepremi.** Esclude chi fa un altro mestiere.
2. **> 50% dei mercati quotati a due lati.** Esclude il direzionale.

**Fonte di «ha montepremi»**: l'unione dei `conditionId` comparsi sul board reward nei **32 giorni**
di storico già sul server — **1.549 mercati**. È un proxy, e il suo limite va detto: il board tiene i
primi N per montepremi, quindi un mercato premiante mai entrato nel taglio risulta «senza montepremi».
**L'errore va nella direzione di sottostimare la quota premiante**, cioè il filtro è conservativo.

---

## 1 · Selezione: **2 dentro, 22 fuori** su 24 candidati

I candidati: i wallet classificati market-maker a due lati sui nostri mercati (analisi di oggi) più i
cinque ricorrenti per nome.

### Chi passa

| wallet | nome | mercati con montepremi | due lati | chiude attivamente |
|---|---|---|---|---|
| `0x7ae4b06f…` | **LosingMoneyGuy** | **78 %** | 92 % | 87 % |
| `0xf7aa193b…` | **IngressDefender** | **77 %** | 94 % | 92 % |

### Chi esce, e perché

**Il risultato che conta: i nomi che promettevano reward farming non passano.**

| nome | montepremi | due lati | motivo dello scarto |
|---|---|---|---|
| `-.liquidity.farm` | **18 %** | 17 % | entrambe le condizioni |
| `rewardcleaner` | 48 % | 98 % | montepremi sotto la maggioranza |
| `friendlyreward` | 43 % | 98 % | montepremi sotto la maggioranza |
| `scalingrewards` | 38 % | 98 % | montepremi sotto la maggioranza |
| `ImSweating` | 31 % | 97 % | montepremi sotto la maggioranza |
| `dh128adj` | 36 % | 96 % | montepremi sotto la maggioranza |
| `Mysaria` | 17 % | **6 %** | entrambe — ed era il più presente sui nostri mercati (7/11) |
| `Bugoz` | 17 % | 93 % | montepremi |
| `hlwp229` | 16 % | 96 % | montepremi |
| `polijump` | 10 % | 85 % | montepremi |
| `ronov3` | 8 % | 99 % | montepremi |
| `smackdatgame` | 6 % | 77 % | montepremi |
| `el-pivot` | 5 % | 100 % | montepremi |
| `Hot-Skull` | 4 % | 49 % | entrambe |
| `ManGoaT007` | 3 % | 100 % | montepremi |
| `AiBird` | 3 % | 76 % | montepremi |
| `fourcoin15m` | 3 % | 3 % | entrambe |
| `slr07` | 2 % | 90 % | montepremi |
| `macrosteaks` | 11 % | 32 % | entrambe |
| `Pavlo7777` | 0,4 % | 35 % | entrambe |
| `filippo.toso` | 23 % | 100 % | montepremi |
| `0xf1a3be80…` | 13 % | 45 % | entrambe |

**Osservazione**: **20 wallet su 22** escono per il *primo* criterio, non per il secondo. Quasi tutti
quotano a due lati (77–100 %) — sono market maker veri — ma **su mercati che non pagano premi**. È
esattamente l'errore del passato colto a monte: la forma è quella giusta, il campo di gioco no.

**⚠ I casi al limite, e il proxy è conservativo.** `rewardcleaner` (48 %), `friendlyreward` (43 %),
`scalingrewards` (38 %) e `dh128adj` (36 %) stanno appena sotto soglia, e la misura sottostima per
costruzione. Con un elenco completo dei mercati premianti alcuni di questi **potrebbero passare**. I
due ammessi passano invece con margine (77–78 %), quindi la loro ammissione non dipende dal proxy.

---

## 2 · Come operano i due sopravvissuti

| | **LosingMoneyGuy** | **IngressDefender** | **noi (parametri attuali)** |
|---|---|---|---|
| finestra osservata | 77,8 h | 43,6 h | — |
| righe di attività | 3.000 (tetto) | 3.000 (tetto) | — |
| mercati con trade | 295 | 359 | 10–11 nel piano |
| **mercati al giorno** | **133** (max 137) | **191** (max 251) | **10–11** |
| size mediana per **fill** | **$4,60** | **$9,20** | $32,50 per lato quotato |
| size p90 per fill | $24,41 | $39,44 | — |
| **pool mediano** | **$89/g** | **$84/g** | $42–136, mediana ~$55 |
| banda mediana | 4,5 ¢ | 4,5 ¢ | 4,5 ¢ |
| **orizzonte mediano** | **32,8 h** | **30,8 h** | pavimento 18 h |
| rapporto size fra i lati | 0,655 | 0,436 | 1,0 per costruzione |
| chiusura attiva | 87 % | 92 % | merge collegato |
| **come chiudono** | 108 MERGE, 57 REDEEM | **798 MERGE**, 87 REDEEM | merge on-chain attivo |
| netto aperto osservato | $3.673 | **$29.007** | $663 di capitale |
| categoria | **100 % meteo** | **100 % meteo** | 10/11 meteo |

**Tre cose che saltano all'occhio.**

- **Sono monoculturali**: 2.825 e 2.108 trade, **tutti su meteo**. Zero sport, zero politica, zero
  cripto. La nostra selezione ci arriva per conto suo (10 mercati su 11 erano meteo), ma per loro non
  è un esito: è la strategia.
- **Il MERGE è il meccanismo di chiusura principale**, non la vendita. IngressDefender ha **798 merge**
  su 2.108 trade: compone la coppia e la fonde, invece di vendere il lato riempito. È esattamente il
  percorso che questo repo ha collegato (§5 punti 45, 49, 52).
- **Il rapporto fra i lati NON è 1.** 0,655 e 0,436: quotano a due lati ma con size deliberatamente
  diverse. Noi quotiamo simmetrico per costruzione (`Q = capitale / (p_yes + p_no)`).

---

## 3 · Dove siamo diversi, per impatto atteso

### ① Numero di mercati: **10–11 contro 133–191** — divergenza NON intenzionale

È la differenza più grande e la più costosa. **E contraddice la filosofia che CLAUDE.md dichiara.**
§4 e §5 punto 65 scrivono, sulla scelta del tetto fisso: *«quando il capitale cresce si spalma su PIÙ
mercati, non si ingrossa la size su ciascuno»*, e *«il numero di mercati è una CONSEGUENZA
(capitale ÷ 130)»*. Con il tetto sceso a **$65** (§5 punto 52 ①) e $663 di capitale, quella
conseguenza è **10 mercati** — mentre chi fa lo stesso mestiere ne tiene **quindici volte tanti**.

La costante è deliberata e ben motivata (il residuo scoperto sotto il minimo del venue: $130 → 15 % di
fill sopravvivibile, $65 → 30 %). **Ma la conseguenza sul numero di mercati non è mai stata misurata
contro chi opera davvero**, ed è l'opposto di ciò che la stessa sezione dichiara di volere.

### ② Size per ordine: la nostra è 4–7× la loro — probabilmente NON intenzionale

La loro size **mediana per fill** è $4,60–9,20; la nostra size **quotata** per lato è $32,50.
⚠ Non sono la stessa grandezza (vedi §4): un fill può essere parziale. Ma il p90 dei loro fill è
$24–39, cioè **l'ordine intero di un nostro lato sta al 90° percentile dei loro fill**. Con size
piccole su molti mercati la quota di ciascun pool è bassa ma il rischio di fill avverso è distribuito;
con size grandi su pochi mercati è il contrario.

### ③ Pool: loro **$84–89**, noi mediana **~$55** — divergenza non intenzionale, e ribalta una conclusione di stamattina

L'analisi di stamattina concludeva che «il montepremi alto è un'esca», perché i nostri mercati a pool
alto rendevano meno. **Con questi dati la conclusione va corretta**: i due affini scelgono
sistematicamente pool **più grandi** dei nostri. La differenza è che ci stanno con size minuscole
spalmate su centinaia di mercati — non competono per la quota di un pool, **raccolgono una fetta
piccola di molti pool**. Il montepremi alto è un'esca *per chi ci mette $65*; non lo è per chi ci mette
$5 su duecento mercati.

### ④ Orizzonte: loro 31–33 h mediane, noi pavimento 18 h — scelta nostra, e sostanzialmente allineata

Il nostro pavimento (`MIN_HORIZON_DAYS = 0,75`) è documentato e tarato sui dati (§5 punto 38 fase 1,
mediana 22,7 h sui soli ingressi premianti). I due affini stanno intorno a **31 h**, dentro la nostra
finestra. **Nessuna azione**: qui siamo allineati.

### ⑤ Simmetria: loro 0,44–0,66, noi 1,0 — scelta nostra, deliberata

Il nostro modello compra share uguali sui due lati (`plan-to-orders`), quindi il rapporto è 1 per
costruzione. Loro sbilanciano. Non so *perché* lo facciano — se sia gestione dell'inventario o
risposta al book — e con questi dati non è distinguibile.

### ⑥ Chiusura via merge: allineati — scelta nostra, già fatta

Loro chiudono all'87–92 % attivamente, con il merge come strumento principale. Il repo ha già
collegato il merge on-chain e lo esegue. **Nessuna azione.**

---

## 4 · Cosa NON è stato misurato, e perché

- **Size per ORDINE.** I trade dicono cosa è stato *eseguito*, non cosa era *quotato*: un fill può
  essere parziale, e un ordine mai colpito non compare. Tutte le size di questo documento sono **size
  per fill**. Per la size quotata servirebbe un feed order-by-order che non abbiamo.
- **Distanza dal mid a cui quotano.** L'attività porta il prezzo del trade ma non il mid di quel
  momento. Sarebbe ricostruibile solo per i mercati e le finestre in cui `mid-history` li copre —
  e questi due wallet operano su 295–359 mercati, la quasi totalità fuori dalla nostra copertura.
- **Capitale realmente impiegato.** `$3.673` e `$29.007` sono il **netto aperto osservato nella
  finestra** (acquisti meno vendite per mercato). La finestra è troncata dal tetto di 3.000 righe: se
  taglia a metà un ciclo compra-vendi, il netto è sovrastimato. Va letto come ordine di grandezza.
- **Quanto restano a riposo.** Stessa risposta di stamattina: servono ≥3 giorni di sottoscrizione
  continua per mercato a cadenza ≤2 min. Non c'è, e non si stima.
- **La finestra non è la stessa per i due wallet** (77,8 h contro 43,6 h): entrambi hanno saturato il
  tetto di 3.000 righe, quindi i conteggi assoluti non sono confrontabili fra loro. Le **frazioni** e
  le **mediane** lo sono.
- **`MAKER_REBATE`/`REWARD` sono pochissimi** (3–4 righe per wallet nella finestra): non bastano a
  stimare quanto incassano davvero. Servirebbe la finestra completa di un mese.

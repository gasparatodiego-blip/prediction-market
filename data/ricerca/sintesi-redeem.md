# Il redeem è una view o è gestione del residuo? — misurato

## Prima: il confondente c'era, ed è stato escluso

Il sospetto era che una posizione risolta a **0** non generasse un evento REDEEM: in quel caso contare
i redeem misurerebbe **solo i vincenti per costruzione**, e ogni conclusione sarebbe un artefatto.

**Verificato che non è così.** Su `activity`, un REDEEM porta `usdcSize/size` esattamente **0.0000
oppure 1.0000**, niente in mezzo, e **gli eventi con `usdcSize: 0` esistono** (esempio reale:
`size: 300, usdcSize: 0`). Il perdente genera l'evento come il vincente. Quindi il rapporto è misurabile.

## La misura: 5.087 redeem su 8 wallet

| wallet | strato | redeem | vinte (=1) | perse (=0) | **quota vinte** | carico med. vinte | carico med. perse | con carico |
|---|---|---|---|---|---|---|---|---|
| `0xfb1c3c1a…` | i21 | 889 | 595 | 294 | **66,9%** | 0,580 | 0,384 | 881/889 |
| `0x2037bb7a…` | i21 | 474 | 474 | 0 | **100,0%** | **0,999** | — | 474/474 |
| `0x7bc14171…` | media | 35 | 35 | 0 | 100,0% | 0,694 | — | 28/35 |
| `0x33bcb6e9…` | i21 | 1.860 | 1.860 | 0 | **100,0%** | **0,999** | — | 1810/1860 |
| `0x4a1a27c4…` | i21 | 402 | 396 | 6 | 98,5% | 0,989 | 0,490 | 325/402 |
| `0x0dedae6a…` | media | 669 | 663 | 6 | 99,1% | 0,582 | 0,134 | 651/669 |
| `0x9977760c…` | media | 694 | 694 | 0 | **100,0%** | **0,999** | — | 692/694 |
| `0xac4a1fab…` | top30 | 64 | 64 | 0 | 100,0% | 0,564 | — | 42/64 |

**AGGREGATO: 4.781 vinte su 5.087 = 94,0%. Perse: 306 = 6,0%.**
Carico ricostruibile su **4.903/5.087 (96,4%)**: costo $7.444.490, incasso $7.818.751, **PnL +$374.261
(+5,03%)**.

## La risposta: SANNO. E ci sono due modi diversi di sapere

Il 94% non lascia spazio all'ipotesi «redimono indistintamente accettando che una parte vada a zero».
Ma il **prezzo di carico** mostra che i due gruppi sanno per ragioni opposte:

| | famiglia A — quasi-certezze | famiglia B — view |
|---|---|---|
| wallet | `0x2037bb7a`, `0x33bcb6e9`, `0x9977760c` | `0xfb1c3c1a`, `0x0dedae6a` |
| prezzo mediano di acquisto | **0,990 – 0,999** | **0,45 – 0,46** |
| acquisti sopra 97¢ | **52,6% – 96,1%** | **0,0%** |
| quota vinte | 98,5 – 100% | 66,9 – 99,1% |
| PnL per operazione | +0,19% / +0,60% | +33% / +76% |
| cosa fanno | comprano esiti **già decisi** a 99,9¢ per incassare l'ultimo centesimo | comprano a **metà prezzo** e hanno ragione due volte su tre |

La famiglia A non ha una view predittiva: raccoglie l'ultimo decimo di centesimo su mercati risolti di
fatto, e intanto matura reward. La famiglia B ha un **edge vero**: comprare a 0,58 e vincere il 66,9%
delle volte vale +8,9 centesimi per share, cioè **+15%** di vantaggio.

**In nessuno dei due casi il redeem è gestione di un residuo.** È l'uscita **pianificata** di una
posizione presa apposta.

## Cosa questo cambia per noi — e cosa NON cambia

**⚠ Devo correggere l'inquadramento della sessione precedente.** Avevo scritto «i sei wallet con meno
residui escono via redeem all'87-98%, noi al ~8%» in un modo che suggeriva di imitarli. **Quel 94% è
una proprietà della loro SELEZIONE, non del meccanismo del redeem.** Noi non lo erediteremmo: i nostri
residui nascono da fill parziali di coppie neutrali, quindi il loro esito è ~la probabilità implicita
del mercato. Redimendoli incasseremmo il valore atteso equo, **non il 94%**.

**Quello che invece resta valido, e per una ragione indipendente**: il redeem **non ha una size minima**,
mentre gli ordini sì (20 share). Per le nostre **10 posizioni da $50,32** il confronto vero non è
«redeem al 94% contro vendita con spread» — è **«redeem al valore equo, zero spread, zero minimo»
contro «capitale congelato perché nessun ordine valido esiste»**. Sono due domande diverse, e la
seconda si risolve col meccanismo a prescindere dal tasso di vittoria altrui.

## Un fatto collaterale che tocca una nostra regola esplicita

La famiglia A opera **dove noi per regola non andiamo**: `end-of-scale` rifiuta di quotare **sotto 3¢
e sopra 97¢**, e il 52,6-96,1% dei loro acquisti sta **sopra 97¢**.

⚠ **Non lo riporto come un'occasione persa.** Comprare a 99,9¢ ha un profilo di rischio asimmetrico e
brutale: si rischiano 99,9 centesimi per guadagnarne 0,1, quindi **un solo errore cancella circa mille
operazioni riuscite**. La regola `end-of-scale` esiste esattamente contro quel modo di fallire, ed è
una scelta, non una svista. Lo riporto perché il costo della regola sia **misurato invece che ignoto**:
esclude strutturalmente una delle due famiglie che vivono di reward. Se valga la pena è una decisione
sul capitale, e non è mia.

## Limiti

- Otto wallet, 5.087 redeem, finestra di ~5.500 eventi ciascuno. Il carico è ricostruibile sul 96,4%
  dei redeem: il resto è comprato prima della finestra ed è **escluso**, non stimato.
- Il PnL aggregato (+5,03%) è dominato da pochi wallet grandi: **non è il rendimento tipico**, è la
  somma. I singoli vanno letti riga per riga.

# `CICLO FERMATO` di agent41 — 12 agosto 2026, 09:41-09:42 UTC

**SOLA DIAGNOSI. Nessuna correzione, agent41 non riavviato, flag di dry-run non toccato.**

## Quale mercato

L'ultimo giro ne rifiutava **uno**, ed è

```
0x8d8139e911d3ba97bc5e1598058529f252c43808b8d337ce656110c01eda77d2
```

rifiutato alle `09:42:36.949Z`. Non è però un caso isolato: le tre passate hanno escluso **11 mercati
in tutto** (8 + 2 + 1), e **tutti con lo stesso identico motivo e la stessa identica scadenza**:

```json
{"fase":"verifica-piano","evento":"in-scadenza","passata":3,
 "marketId":"0x8d8139e9…","valido":false,
 "motivo":"mancano 14.3h alla risoluzione (soglia 24h): non vale un'allocazione nuova",
 "endDate":"2026-08-13T00:00:00Z","oreResidue":14.29}
```

Sono la coorte dei mercati giornalieri che scadono tutti a `2026-08-13T00:00:00Z`.

## Perché viene rifiutato

**Non dal venue, e non per una ragione tecnica.** Il rifiuto è nostro: `marketValidity`
(`lib/maker/market-validity.js:28`) applica

```js
const HORIZON_MIN_HOURS = 24;   // meno di un giorno alla risoluzione ⇒ non vale un'allocazione nuova
```

e a 14,3 ore dalla risoluzione il mercato è `in-scadenza`. Il messaggio del referto — «mercati che il
venue rifiuta» — è quindi **fuorviante**: il venue non è stato interrogato su questo punto.

## Perché si ripete tre volte e il ciclo si ferma

Due soglie per la stessa domanda, in due moduli che non si parlano:

| chi | costante | valore |
|---|---|---|
| **pianificatore** | `MIN_HORIZON_DAYS` — `lib/rewards/horizon.js:97` | 0,75 g = **18 h** |
| **verifica del piano** | `HORIZON_MIN_HOURS` — `lib/maker/market-validity.js:28` | **24 h** |

`horizonFilter: true` è attivo (agent41 righe 366 e 446), quindi il filtro gira — ma con un pavimento
più basso di quello che poi giudica. **Fra 18 e 24 ore esiste una fascia in cui il pianificatore alloca
e la verifica rifiuta**, per costruzione e per sempre.

**E qui il mercato aveva 14,3 ore, cioè sotto ENTRAMBE le soglie**: il pavimento a 18 h avrebbe dovuto
escluderlo da solo. Quindi al momento del piano la scadenza **non era leggibile**. Due riscontri:

- il board normalizzato (`/tmp/liquidity-rewards.json`, 306 righe) **non porta `endDate`**: le sue
  chiavi di tempo sono `hoursToResolution` e `updatedAt`. `horizonVerdict` legge invece una stringa ISO
  `endDate` (`lib/rewards/horizon.js:164-167`), e una scadenza assente vale `unknown`;
- `unknown` **non esclude mai** — è la regola cardinale dichiarata («ABSENCE OF EVIDENCE»,
  `horizon.js:37`). La scadenza del piano arriva da una lettura separata di Gamma
  (`agent41:230`, `end_date_iso`); dove quel campo manca, il mercato entra nel piano qualunque sia la
  sua scadenza vera.

Ogni ricalcolo rimpiazza gli esclusi con altri mercati **della stessa coorte** (stessa scadenza
`2026-08-13T00:00:00Z`), quindi tre passate non bastano e il ciclo si ferma:

```
"azione":"fermato","motivo":"dopo 3 ricalcoli il piano contiene ancora mercati che il venue
rifiuta (1 all'ultimo giro): la fotografia da cui nasce il piano non è affidabile —
nessun ordine viene toccato"
```

## Cosa ha funzionato

**Il fail-closed.** `"ok":false, "azione":"fermato"`, `dryRun:true`, nessun ordine toccato: davanti a un
piano che non supera la propria verifica il ciclo non ha piazzato niente e non ha cancellato niente. È
il comportamento giusto — il difetto non è che si sia fermato, è che **il piano nasce senza
l'informazione con cui verrà giudicato**.

## Nota

Il test `lib/rewards/scadenza-ereditata.test.js` è uno dei 7 rossi noti e vive esattamente su questa
superficie («FAIL: il mercato entra nel piano — scartato»). Chi affronterà il difetto lo trova già lì,
e probabilmente lo riporta verde nello stesso gesto.

**Nessuna correzione proposta qui**: toccare una soglia di orizzonte sposta l'allocazione di capitale
reale, ed è una decisione dell'operatore.

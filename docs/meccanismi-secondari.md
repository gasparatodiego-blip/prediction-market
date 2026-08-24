# Meccanismi secondari, vivi e in servizio — l'auto-sblocco, il riscatto, la quarantena, la sentinella

**A cosa serve.** Sono meccanismi **VIVI** (non storia): stavano nel riquadro «I quattordici episodi
chiusi» in cima a `CLAUDE.md` e sono stati spostati qui il **23 agosto 2026** perché la testata tornasse
leggibile. **Nessuno di essi è stato spento o modificato.** In `CLAUDE.md` resta il rimando e la riga che
dice quali regole vivono dove; la narrativa dei quattordici episodi resta in `docs/episodi-chiusi.md`.

⚠ Chi tocca uno di questi meccanismi aggiorni **questo** file, e lasci in `CLAUDE.md` solo il rimando.

### Il blocco «I quattordici episodi chiusi» della testata — testo integrale, spostato il 23 agosto 2026

> ## 📚 I QUATTORDICI EPISODI CHIUSI — narrativa in **`docs/episodi-chiusi.md`**, qui solo le REGOLE VIVE
> **Dove sono finite le regole**: il **vuoto di tre ore** ⇒ §4.3 (griglia limitata anche dal tetto, 8
> livelli minimi) + sentinella sul vuoto (5 min) + recupero della scadenza a tre fonti (§4.6) · il
> **capitale al lavoro** ⇒ §4.5 · **dove muoiono le gambe** ⇒ §4.2 · **quanti mercati vede il bot** ⇒ §4.7
> e §5.2 p.55 · la **scala di urgenza** ⇒ §4.6 · i **residui sotto il minimo** ⇒ §4.6 e il riscatto
> on-chain (bloccato adesso **$3,00**) · il **guardiano k=2** ⇒ §3.
> ⚠ **Pannello Polymarket e bot misurano cose diverse e possono essere entrambi giusti**: «disponibile per
> il trading» **è il cash** e non sottrae i BUY a riposo; il bot conta **posizioni + ordini a riposo**.
> ⚠ **`ultimoCicloOk` si timbra in TRE punti** — a fine giro e nei due rami «nessuna azione», perché anche
> un giro che non trova niente HA girato.
> **🤖 IL BOT SI SBLOCCA DA SOLO** (p.124-127) — **principio: ogni difesa AGISCE, non segnala soltanto**; e
> la metà opposta, **quando l'unica via d'uscita violerebbe una regola di rischio il bot non agisce e lo
> dichiara**. **①** `sblocco-progressivo.js`: **5** rifiuti identici di fila sulla stessa coppia (mercato,
> gate) sono un blocco strutturale; **37 famiglie** in tre classi — `rischio` (56% dei rifiuti) ⇒ nessuna
> azione, si cambia mercato e si dichiara perché · `stato-bot` ⇒ via alternativa vera · `transitorio` ⇒ non
> è un blocco. **Famiglia sconosciuta ⇒ trattata come rischio.** **②** `coerenza-soglie.js`: prima di
> proporre righe si verifica che chi le riceve le accetti, e il capitale **può solo SCENDERE**. **③ SCALA
> DI SBLOCCO**, un gradino ogni **5 minuti**: `ricostruisci-piano` → `ricarica-configurazione` →
> `riconcilia-esposizione` → `ripara-precondizioni` → `risveglia-feed` → **`fermati-in-sicurezza`**
> (gradino 6, **DISARMATO**). Caso peggiore: FERMA in ~30 minuti. **Nessun gradino tocca una regola di
> rischio**, per struttura. **④ AUTODIAGNOSI ogni 120 s**: ordini vivi > 0 · capitale al lavoro ≥ **50% per
> 15 minuti** · un ciclo negli ultimi **20 min** · rinnovi dovuti non fermati oltre l'**80%**. Tutto
> illeggibile ⇒ **non si giudica** e la scala non parte.
> **💰 RISCATTO AUTOMATICO DOPO LA RISOLUZIONE** (`lib/maker/riscatto-automatico.js`, agganciato alla
> scansione dei registri di agent40): **⚠ il segnale è `payoutDenominator(conditionId) > 0` LETTO
> ON-CHAIN, non «il mercato è chiuso»** — `closed`/`acceptingOrders` diventano veri ore prima che l'oracolo
> riporti l'esito, e un tentativo prima è un revert che costa gas. **Non letto ⇒ non si riscatta.**
> **Idempotente** con registro su disco (`data/riscatti.json`), **3 tentativi** poi **10 minuti** di
> backoff per mercato, al più **3 mercati per giro**. `negRisk` non booleano ⇒ non si tenta.
> **🧹 QUARANTENA VENUE**: il board è sporco per una **CLASSE** di mercati (`premio-crollato`) e tre passate
> contro N mercati sporchi non convergono. Si pulisce la fonte: l'esito della verifica al venue
> **sopravvive al ciclo** (`quarantena-venue.js`, **20 minuti**). **Non è un cancello**: un mercato in
> quarantena che arrivasse al piazzamento sarebbe giudicato da tutti i gate come prima.
> **📉 SENTINELLA SUL COLLASSO DELLA COPERTURA — SOLO OSSERVA**: calo **≥ 85% dal MASSIMO delle ultime 10
> minuti**, non fra campioni consecutivi. **85 e non 80 perché il divario è VUOTO**: fisiologico massimo
> 75%, patologico minimo 92,9%. **⚠ Non si auto-inganna**: se un latch del guardiano cade nei **15 minuti**
> precedenti il calo è **SPIEGATO** e non si arma; latch illeggibile ⇒ non si arma. **⚠ Log e giornale
> soltanto**: non ferma il bot e non tocca AVVIA/FERMA, e un test lo verifica **per assenza**.
> **🪙 LA GAMBA SORELLA SI ABBASSA DENTRO LA BANDA**: quando il tetto della coppia cade **sopra** il bordo
> alto della banda premiante si scende fino al bordo. **⚠ Non allenta niente**: è un `Math.min`, il prezzo
> può solo scendere; banda non leggibile o bordo sopra il tetto ⇒ prezzo **identico a prima**.
---

---

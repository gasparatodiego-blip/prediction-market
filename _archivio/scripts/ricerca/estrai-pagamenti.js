#!/usr/bin/env node
'use strict';
// scripts/ricerca/estrai-pagamenti.js — FASE 1: i pagamenti giornalieri, dalla catena.
//
// SOLA LETTURA, e solo verso Polygon. Non importa niente da `lib/maker/` o `lib/venues/`: non ha modo
// di piazzare né cancellare un ordine. Scrive solo sotto `data/ricerca/`.
//
// COSA FA. Per ognuno degli ultimi N giorni: trova il blocco della mezzanotte UTC, apre una finestra
// stretta attorno, e raccoglie i Transfer di pUSD usciti dal distributore. Il risultato è la lista
// completa dei destinatari con l'importo esatto, giorno per giorno.
//
// ⚠ IL DISTRIBUTORE VA VERIFICATO, NON ASSUNTO. Il primo giro serve a rispondere a due domande prima
// di fidarsi: quel mittente paga TUTTI i giorni o è un caso isolato? e ci sono ALTRI mittenti che
// pagano nella stessa finestra? La seconda si risponde guardando la finestra senza filtro sul
// mittente e contando chi altro manda pUSD a molti destinatari nello stesso istante.

const fs = require('fs');
const path = require('path');
const O = require('./lib-onchain');

const DISTRIBUTORE = '0x2c2795EA295d5Eb51F9121B728eD2eA4e936a709'.toLowerCase();
const GIORNI = Number(process.argv[2]) || 30;
const OUT = path.join('data', 'ricerca');

// Un pagamento «di massa» è una transazione che manda pUSD a molti destinatari insieme. 20 è la
// soglia: sotto, è un trasferimento ordinario e non una distribuzione.
const SOGLIA_MASSA = 20;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const oggi = new Date(O.ANCORA_MS);
  oggi.setUTCHours(0, 0, 0, 0);

  const giorni = [];
  const altriMittenti = new Map();

  for (let i = 0; i < GIORNI; i += 1) {
    const msMezzanotte = oggi.getTime() - i * 86_400_000;
    const iso = new Date(msMezzanotte).toISOString().slice(0, 10);
    let b;
    try { b = await O.bloccoAllIstante(msMezzanotte); }
    catch (e) { giorni.push({ giorno: iso, errore: e.message, pagamenti: [] }); continue; }

    const da = b.numero - 30;                 // qualche blocco prima: il pagamento è a 00:00:0x
    const a = b.numero + O.FINESTRA_BLOCCHI;

    let nostri = [];
    try { nostri = await O.trasferimentiDaStorico(DISTRIBUTORE, da, a); }
    catch (e) { giorni.push({ giorno: iso, errore: e.message, blocco: b.numero, pagamenti: [] }); continue; }

    // ── CHI ALTRO PAGA IN QUESTA FINESTRA ────────────────────────────────────────────────────────
    // Si guarda la finestra SENZA filtro sul mittente e si contano i mittenti con molti destinatari.
    // È così che si scopre un secondo distributore (per esempio uno separato per i rimborsi maker)
    // invece di assumere che ce ne sia uno solo.
    try {
      const tutti = await O.rpc('eth_getLogs', [{
        fromBlock: '0x' + da.toString(16), toBlock: '0x' + Math.min(a, b.numero + 60).toString(16),
        address: O.PUSD, topics: [O.TOPIC_TRANSFER],
      }]);
      const perMittente = new Map();
      for (const l of tutti || []) {
        const from = '0x' + String(l.topics[1]).slice(26).toLowerCase();
        if (!perMittente.has(from)) perMittente.set(from, { n: 0, usd: 0 });
        const v = perMittente.get(from);
        v.n += 1; v.usd += Number(BigInt(l.data)) / 1e6;
      }
      for (const [from, v] of perMittente) {
        if (v.n < SOGLIA_MASSA || from === DISTRIBUTORE) continue;
        if (!altriMittenti.has(from)) altriMittenti.set(from, { giorni: 0, destinatari: 0, usd: 0 });
        const x = altriMittenti.get(from);
        x.giorni += 1; x.destinatari += v.n; x.usd += v.usd;
      }
    } catch { /* la scoperta dei paralleli è best-effort: non deve far cadere l'estrazione */ }

    const tot = nostri.reduce((s, x) => s + x.usd, 0);
    giorni.push({
      giorno: iso, blocco: b.numero, bloccoIso: new Date(b.ms).toISOString(),
      destinatari: nostri.length, totaleUsd: +tot.toFixed(6),
      tx: [...new Set(nostri.map((x) => x.tx))],
      pagamenti: nostri.map((x) => ({ a: x.a, usd: x.usd })),
    });
    process.stderr.write(`  ${iso}: ${nostri.length} destinatari · $${tot.toFixed(2)}\n`);
  }

  const body = {
    generatoIl: new Date().toISOString(),
    distributore: DISTRIBUTORE,
    giorniRichiesti: GIORNI,
    giorniConPagamento: giorni.filter((g) => g.destinatari > 0).length,
    altriMittentiDiMassa: [...altriMittenti.entries()]
      .map(([id, v]) => ({ id, ...v, usd: +v.usd.toFixed(2) }))
      .sort((a, b2) => b2.usd - a.usd),
    rpcChiamate: O.contatore.chiamate,
    giorni,
  };
  fs.writeFileSync(path.join(OUT, 'pagamenti-onchain.json'), JSON.stringify(body, null, 1));
  console.log(JSON.stringify({
    giorniConPagamento: body.giorniConPagamento,
    giorniRichiesti: GIORNI,
    altriMittenti: body.altriMittentiDiMassa.length,
    rpcChiamate: O.contatore.chiamate,
    ritentate: O.contatore.ritentate,
  }, null, 1));
})().catch((e) => { console.error('ESTRAZIONE FALLITA:', e.message); process.exit(1); });

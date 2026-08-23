'use strict';
// SOLA LETTURA — ordini morti per GTD senza rinnovo, e stato del rinnovo esente. 23 agosto 2026.
// Legge SOLO la coda del giornale maker (append-only): nessuna scrittura fuori da data/ricerca/.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const GIORNALE = path.join(ROOT, 'data/polymarket-maker-audit.jsonl');
const OUT = path.join(ROOT, 'data/ricerca/ordini-morti-gtd-1530.json');

// si legge a blocchi dalla CODA: il file è ~340 MB e readFileSync costruirebbe una stringa sola.
function codaRighe(file, bytes) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const s = buf.toString('utf8');
  const i = s.indexOf('\n');
  return (i >= 0 ? s.slice(i + 1) : s).split('\n');
}

const now = Date.now();
const ORA = 3600_000;
const finestre = { '1h': now - ORA, '7h': now - 7 * ORA };

const conta = {
  '1h': { scadutoSenzaRinnovo: 0, nozionaleUsd: 0, senzaNozionale: 0, perGate: {}, mercati: new Set() },
  '7h': { scadutoSenzaRinnovo: 0, nozionaleUsd: 0, senzaNozionale: 0, perGate: {}, mercati: new Set() },
};
const anomalie = { '1h': [], '7h': [] };
const esenti = { '1h': 0, '7h': 0, totale: 0, primaVistaIso: null };
const rifiutiRinnovo = { '1h': {}, '7h': {} };
let righeLette = 0, righeMalformate = 0, primaRigaIso = null;

// 900 MB di coda ≈ tutto ciò che serve per 7 ore (67-82 MB/giorno… in realtà molto di più: si legge
// finché la prima riga letta è più vecchia della finestra, con un tetto)
let bytes = 64 * 1024 * 1024;
for (let giro = 0; giro < 6; giro++) {
  const righe = codaRighe(GIORNALE, bytes);
  righeLette = 0; righeMalformate = 0;
  for (const k of Object.keys(conta)) { conta[k] = { scadutoSenzaRinnovo: 0, nozionaleUsd: 0, senzaNozionale: 0, perGate: {}, mercati: new Set() }; anomalie[k] = []; rifiutiRinnovo[k] = {}; esenti[k] = 0; }
  esenti.totale = 0; esenti.primaVistaIso = null; primaRigaIso = null;

  for (const l of righe) {
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch (_) { righeMalformate++; continue; }
    righeLette++;
    const ts = Number(r.ts || r.at || 0);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (primaRigaIso === null) primaRigaIso = new Date(ts).toISOString();

    for (const [nome, da] of Object.entries(finestre)) {
      if (ts < da) continue;
      const o = r.outcome || r.esito || null;
      if (o === 'scaduto-senza-rinnovo') {
        const c = conta[nome];
        c.scadutoSenzaRinnovo++;
        const noz = Number(r.notionalUsd ?? r.nozionaleUsd ?? (Number(r.price) * Number(r.size)));
        if (Number.isFinite(noz) && noz > 0) c.nozionaleUsd += noz; else c.senzaNozionale++;
        const g = r.gate || r.reasonCode || '(senza gate)';
        c.perGate[g] = (c.perGate[g] || 0) + 1;
        if (r.marketId || r.market) c.mercati.add(r.marketId || r.market);
      }
      if (o === 'anomalia-scadenze-senza-rinnovo') anomalie[nome].push({ ts: new Date(ts).toISOString(), quanti: r.quanti ?? r.numero ?? null, nozionaleUsd: r.nozionaleUsd ?? r.notionalUsd ?? null, perGate: r.perGate ?? null, senzaNozionale: r.senzaNozionale ?? null });
      // il rinnovo che è passato grazie all'esenzione dal pavimento
      if (r.rinnovoEsente === true || r.provaRinnovo?.esente === true || r.esenzioneRinnovo === true) esenti[nome]++;
      // i rinnovi ancora rifiutati
      if (o === 'scaduto-senza-rinnovo' || r.gate === 'motore-non-conforme') {
        const causa = (r.reason || r.motivo || '').match(/profondita-insufficiente|banda|mai primo|fine scala|mid stantio|tetto|prezzo/i);
        const k = r.gate === 'motore-non-conforme' ? (causa ? causa[0].toLowerCase() : 'motore-non-conforme (causa non estratta)') : null;
        if (k) rifiutiRinnovo[nome][k] = (rifiutiRinnovo[nome][k] || 0) + 1;
      }
    }
    if (r.rinnovoEsente === true) { esenti.totale++; if (!esenti.primaVistaIso) esenti.primaVistaIso = new Date(ts).toISOString(); }
  }
  if (primaRigaIso && Date.parse(primaRigaIso) <= finestre['7h']) break;
  bytes *= 2;
  if (bytes > 1024 * 1024 * 1024) break;
}

const out = {
  atIso: new Date(now).toISOString(),
  giornale: GIORNALE,
  bytesLetti: bytes,
  righeLette, righeMalformate,
  primaRigaLettaIso: primaRigaIso,
  copreLaFinestra7h: primaRigaIso ? Date.parse(primaRigaIso) <= finestre['7h'] : false,
  finestre: Object.fromEntries(Object.entries(conta).map(([k, v]) => [k, {
    ordiniMortiPerGtdSenzaRinnovo: v.scadutoSenzaRinnovo,
    nozionaleUscitoDalLibroUsd: +v.nozionaleUsd.toFixed(2),
    ordiniSenzaNozionaleLeggibile: v.senzaNozionale,
    mercatiDistinti: v.mercati.size,
    perGate: v.perGate,
  }])),
  anomalieDichiarate: anomalie,
  rinnovoEsente: esenti,
  rifiutiDiRinnovoPerCausa: rifiutiRinnovo,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
console.log('scritto:', OUT);

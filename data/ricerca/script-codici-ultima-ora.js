// Conteggio dei codici di rifiuto sul minimo nell'ULTIMA ORA (o nella finestra passata da argv).
// SOLA LETTURA. Legge solo il file corrente: un'ora non attraversa mai la rotazione.
const fs = require('fs'), readline = require('readline');
const CUR = '/home/bot/bot/data/polymarket-maker-audit.jsonl';
const ORA = Number(process.env.FINE_MS || Date.now());
const MIN = Number(process.env.FINESTRA_MIN || 60);
const CUT = ORA - MIN * 60 * 1000;
const CODICI = ['BELOW_MIN_SIZE', 'BELOW_MIN_ORDER_SIZE', 'MIN_ORDER_SIZE_UNREADABLE'];
(async () => {
  const rl = readline.createInterface({ input: fs.createReadStream(CUR), crlfDelay: Infinity });
  const tot = new Map(CODICI.map((c) => [c, 0]));
  const perSize = new Map();  // codice|size -> n
  const perOp = new Map();
  let esaminate = 0;
  for await (const l of rl) {
    if (l.indexOf('MIN_SIZE') < 0 && l.indexOf('MIN_ORDER_SIZE') < 0) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!Number.isFinite(r.ts) || r.ts < CUT || r.ts > ORA) continue;
    if (!String(r.outcome || '').startsWith('reject')) continue;
    esaminate++;
    const codes = [];
    if (Array.isArray(r.reasons)) r.reasons.forEach((x) => x && x.code && codes.push(x.code));
    if (typeof r.reason === 'string') { const c = String(r.reason).split(':')[0].trim(); if (c) codes.push(c); }
    for (const c of CODICI) {
      if (!codes.includes(c)) continue;
      tot.set(c, tot.get(c) + 1);
      const s = r.requested && r.requested.size;
      const k = c + ' | size ' + (Number.isFinite(s) ? s : 'n/d');
      perSize.set(k, (perSize.get(k) || 0) + 1);
      const ko = c + ' | ' + String(r.op || 'ignoto');
      perOp.set(ko, (perOp.get(ko) || 0) + 1);
    }
  }
  const out = {
    finestra: { daIso: new Date(CUT).toISOString(), aIso: new Date(ORA).toISOString(), minuti: MIN },
    totali: Object.fromEntries(tot),
    perCodiceESize: [...perSize.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })),
    perCodiceEOp: [...perOp.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })),
    righeRifiutoEsaminate: esaminate,
  };
  console.log(JSON.stringify(out, null, 2));
})();

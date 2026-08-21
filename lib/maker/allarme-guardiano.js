'use strict';
// lib/maker/allarme-guardiano.js — L'AVVISO CHE RAGGIUNGE UNA PERSONA QUANDO IL GUARDIANO SCATTA.
//
// ═══ PERCHE' ESISTE, col numero che lo giustifica ════════════════════════════════════════════════
// Il 20 agosto 2026 alle 22:36:02 il guardiano e' scattato, ha cancellato gli ordini e ha messo il bot
// su FERMA. Il bot e' ripartito alle 04:42:39Z del giorno dopo: **6h06m a produzione zero**. Quello
// scatto era un falso positivo (§5-bis p.202) e la sua causa e' stata corretta — ma le sei ore non sono
// costate perche' il riarmo e' manuale: sono costate perche' **nessuno sapeva**. Il riarmo manuale e'
// una scelta (sotto); il silenzio no.
//
// ═══ PERCHE' NON UN RIARMO AUTOMATICO ═══════════════════════════════════════════════════════════════
// §2 regola 3 nomina DUE sole strade autonome verso il capitale reale (agent41 e le cancellazioni di
// agent43). Una terza nascerebbe qui, dentro il modulo il cui mestiere e' FERMARE, e riaccenderebbe il
// bot dentro una discesa che — dopo D-D — e' vera per costruzione, perche' i falsi positivi che il
// riferimento fantasma produceva non ci sono piu'. Un timer che riaccende dentro la stessa discesa e'
// esattamente il modo di sbagliare che l'operatore ha nominato.
//
// ═══ COSA GARANTISCE, e sono le uniche tre cose che contano ═════════════════════════════════════════
//   ① NON PUO' RITARDARE LA SPAZZATA: si chiama per ULTIMO, dopo cancellazione, FERMA, referto e latch.
//   ② NON PUO' FARLA FALLIRE: qualunque eccezione e' catturata dal chiamante, e il valore di ritorno
//      non entra in nessuna decisione. Un avviso non consegnato non cambia una riga di cio' che e' gia'
//      successo sul venue.
//   ③ NON AGGIUNGE NEMMENO UNA CHIAMATA NEI GIRI NORMALI: vive solo sul ramo dello scatto, che nella
//      finestra osservabile (4,01 giorni) e' stato percorso una volta.
//
// ⚠ NON CONFIGURATO ⇒ NON SI TENTA, E SI DICHIARA. `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` non sono
// oggi nel `.env` (le stesse due chiavi che legge `agent27-news-guard`): senza, questo modulo scrive nel
// log che l'avviso non e' partito e perche'. E' la forma onesta di una cintura non ancora allacciata —
// dichiarata invece che silenziosa.

const https = require('https');

// ⚠ `Number(null)` E' 0, e qui varrebbe «capitale $0,00» su un avviso di emergenza: la sesta occorrenza
// della famiglia di §5.3, presa dal test e non dalla rilettura. Un valore assente resta «?».
const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));
const soldi = (v) => (Number.isFinite(num(v)) ? `$${num(v).toFixed(2)}` : '?');

/** Il testo dell'avviso. PURA: nessun I/O, cosi' il contenuto si prova senza rete. */
function componiAvviso({ causa = 'drawdown', motivo = '', pnl = null, capitale = null, baseline = null,
  ordiniCancellati = null, mercati = null, botFermato = null, chiusura = null, at = Date.now() } = {}) {
  const quando = new Date(at).toISOString().replace('T', ' ').slice(0, 19);
  const righe = [
    `🛑 GUARDIANO SCATTATO — ${causa === 'perdita-giornaliera' ? 'perdita giornaliera REALIZZATA' : 'drawdown dal massimo'}`,
    `${quando}Z`,
    '',
    causa === 'perdita-giornaliera'
      ? `perdita realizzata oggi: ${soldi(pnl && pnl.pnlUsd)}`
      : `capitale ${soldi(capitale && capitale.totaleUsd)} contro un riferimento di ${soldi(baseline && baseline.baselineUsd)}`
        + `  ⇒  ${soldi(pnl && pnl.pnlUsd)}${pnl && Number.isFinite(pnl.pnlPct) ? ` (${pnl.pnlPct.toFixed(2)}%)` : ''}`,
    '',
    `ordini cancellati: ${ordiniCancellati === null ? '?' : ordiniCancellati}`
      + (Array.isArray(mercati) && mercati.length ? ` su ${mercati.length} mercati` : ''),
    `bot: ${botFermato === true ? 'messo su FERMA' : botFermato === false ? '⚠ FERMA NON scritto — controlla subito' : '?'}`,
  ];
  if (chiusura) {
    righe.push(`posizioni: ${chiusura.daFondere ?? '?'} da fondere · ${chiusura.daVendere ?? '?'} da vendere · ${chiusura.lasciate ?? '?'} lasciate`);
  } else if (causa !== 'perdita-giornaliera') {
    righe.push('posizioni: NON toccate (il drawdown misura un prezzo, che puo\' rientrare)');
  }
  righe.push('', `perche': ${String(motivo || '').slice(0, 300)}`);
  righe.push('', 'PER RIPARTIRE: cancella data/guardian-state.json, poi `node scripts/cli/avvia.js`.',
    'Nessun riarmo automatico: il bot resta fermo finche\' non lo riaccendi.');
  return righe.join('\n');
}

/** Invio best-effort. Non solleva mai: restituisce sempre un esito descritto. */
async function inviaAvviso(testo, { token = process.env.TELEGRAM_BOT_TOKEN || '',
  chatId = process.env.TELEGRAM_CHAT_ID || '', timeoutMs = 5_000, post = null } = {}) {
  if (!token || !chatId) {
    return { inviato: false, motivo: 'Telegram non configurato (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID assenti): l\'avviso resta solo nel log' };
  }
  try {
    if (typeof post === 'function') { await post({ token, chatId, testo }); return { inviato: true, motivo: null }; }
    await new Promise((res, rej) => {
      const corpo = JSON.stringify({ chat_id: chatId, text: testo, disable_web_page_preview: true });
      const req = https.request({
        host: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(corpo) },
        timeout: timeoutMs,
      }, (r) => { r.resume(); r.on('end', () => (r.statusCode >= 200 && r.statusCode < 300 ? res() : rej(new Error(`HTTP ${r.statusCode}`)))); });
      req.on('timeout', () => { req.destroy(new Error(`timeout dopo ${timeoutMs}ms`)); });
      req.on('error', rej);
      req.end(corpo);
    });
    return { inviato: true, motivo: null };
  } catch (e) {
    return { inviato: false, motivo: (e && e.message) || String(e) };
  }
}

module.exports = { componiAvviso, inviaAvviso };

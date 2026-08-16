#!/usr/bin/env node
'use strict';
// scripts/ricerca-categorie-21.js — SU QUALI CATEGORIE DI MERCATO ENTRANO I 21 MAKER, E COSA VEDE IL BOT.
//
// SOLA LETTURA E BASTA. Legge tre cose e non ne scrive nessuna: il giornale degli eventi di
// agent42-watch-makers (data/maker-21-eventi.jsonl), il board di agent24 (data/liquidity-rewards.json)
// e — solo con `--universo` — l'API pubblica di Gamma, senza credenziali. Non tocca ordini, capitale,
// interruttori o stato. Non importa nessun modulo di piazzamento.
//
// Uso:  node scripts/ricerca-categorie-21.js            (i due campioni locali)
//       node scripts/ricerca-categorie-21.js --universo (in più: cosa esiste di premiante su Gamma)

const fs = require('fs');
const path = require('path');
const https = require('https');
const ROOT = path.resolve(__dirname, '..');
const { categoriaDi, famigliaDi, CATEGORIE } = require(path.join(ROOT, 'lib/rewards/categoria-mercato'));

const CON_UNIVERSO = process.argv.includes('--universo');
const pct = (n, t) => (t ? (n / t * 100) : 0);
const p1 = (x) => `${x.toFixed(1)}%`;
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : null);

function leggiEventi() {
  return fs.readFileSync(path.join(ROOT, 'data/maker-21-eventi.jsonl'), 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.tipo === 'ingresso');
}
function leggiBoard() {
  const f = path.join(ROOT, 'data/liquidity-rewards.json');
  const rows = JSON.parse(fs.readFileSync(f, 'utf8')).markets || [];
  return { rows, scrittoMs: fs.statSync(f).mtimeMs };
}
const estraiBoard = (r) => ({ slug: r.slug || r.marketSlug, eventSlug: r.slug || r.marketSlug, titolo: r.question });

/** Conteggio per categoria, con percentuali. Ritorna una mappa categoria → {n, pct}. */
function conta(elementi, estrai = (x) => x) {
  const per = new Map(CATEGORIE.map((c) => [c, 0]));
  for (const el of elementi) per.set(categoriaDi(estrai(el)).categoria, per.get(categoriaDi(estrai(el)).categoria) + 1);
  const tot = elementi.length;
  const out = {};
  for (const [c, n] of per) out[c] = { n, pct: pct(n, tot) };
  return { tot, out };
}

function tabella(titolo, colonne) {
  console.log(`\n${titolo}`);
  const nomi = colonne.map((c) => c.nome);
  console.log('categoria'.padEnd(24) + nomi.map((n) => n.padStart(16)).join(''));
  for (const cat of CATEGORIE) {
    const celle = colonne.map((c) => {
      const v = c.dati.out[cat];
      return v && v.n ? `${String(v.n).padStart(4)} ${p1(v.pct).padStart(7)}` : '       —';
    });
    if (celle.every((x) => x.trim() === '—')) continue;
    console.log(cat.padEnd(24) + celle.map((x) => x.padStart(16)).join(''));
  }
  console.log('totale'.padEnd(24) + colonne.map((c) => String(c.dati.tot).padStart(16)).join(''));
}

(async () => {
  const ing = leggiEventi();
  const { rows: board, scrittoMs } = leggiBoard();
  const prem = ing.filter((r) => r.nelProgrammaPremi === true);

  console.log('═'.repeat(96));
  console.log('RICERCA · CATEGORIE DI MERCATO DEI 21 MAKER DI RIFERIMENTO');
  console.log('═'.repeat(96));
  const ts = ing.map((r) => r.tsMs).filter(Boolean).sort((a, b) => a - b);
  console.log(`campione: ${ing.length} ingressi · ${new Set(ing.map((r) => r.wallet)).size} wallet distinti`
    + ` · ${new Set(ing.map((r) => r.conditionId)).size} mercati distinti`);
  console.log(`periodo:  ${new Date(ts[0]).toISOString()} → ${new Date(ts[ts.length - 1]).toISOString()}`
    + ` (${((ts[ts.length - 1] - ts[0]) / 3600e3).toFixed(1)} ore)`);
  console.log(`board:    ${board.length} mercati, scritto ${new Date(scrittoMs).toISOString()}`);

  const c21 = conta(ing);
  const cPrem = conta(prem);
  const cBoard = conta(board, estraiBoard);
  tabella('① DISTRIBUZIONE PER CATEGORIA', [
    { nome: '21 · tutti', dati: c21 },
    { nome: '21 · premianti', dati: cPrem },
    { nome: 'board bot', dati: cBoard },
  ]);

  console.log('\n② TASSO DI MERCATI PREMIANTI DENTRO OGNI CATEGORIA (i 21)');
  console.log('categoria'.padEnd(24) + 'premianti/ingressi'.padStart(20) + 'tasso'.padStart(9));
  for (const cat of CATEGORIE) {
    const n = c21.out[cat].n; if (!n) continue;
    const k = cPrem.out[cat].n;
    console.log(cat.padEnd(24) + `${k}/${n}`.padStart(20) + p1(pct(k, n)).padStart(9));
  }

  console.log('\n③ SCARTO board − 21(premianti), in punti percentuali');
  const scarti = CATEGORIE.map((cat) => ({ cat, d: cBoard.out[cat].pct - cPrem.out[cat].pct }))
    .filter((x) => Math.abs(x.d) >= 0.05).sort((a, b) => b.d - a.d);
  for (const s of scarti) {
    const segno = s.d > 0 ? '+' : '';
    const barra = '█'.repeat(Math.min(30, Math.round(Math.abs(s.d) / 2)));
    console.log(s.cat.padEnd(24) + `${segno}${s.d.toFixed(1)}`.padStart(7) + '  ' + barra
      + (Math.abs(s.d) >= 10 ? '   ← significativo' : ''));
  }

  console.log('\n④ RIPETIZIONE: i 21 tornano sulle stesse famiglie?');
  const fam = new Map();
  for (const r of ing) {
    const f = famigliaDi(r); const k = f.famiglia || '?';
    if (!fam.has(k)) fam.set(k, { n: 0, tipo: f.tipo, cat: categoriaDi(r).categoria, wallet: new Set(), mercati: new Set() });
    const v = fam.get(k); v.n += 1; v.wallet.add(r.wallet); v.mercati.add(r.conditionId);
  }
  const ordinate = [...fam.entries()].sort((a, b) => b[1].n - a[1].n);
  const cum = (k) => ordinate.slice(0, k).reduce((t, [, v]) => t + v.n, 0);
  console.log(`famiglie distinte: ${ordinate.length} su ${ing.length} ingressi e ${new Set(ing.map((r) => r.conditionId)).size} mercati distinti`);
  console.log(`  prime 10 famiglie → ${cum(10)} ingressi (${p1(pct(cum(10), ing.length))})`);
  console.log(`  prime 20 famiglie → ${cum(20)} ingressi (${p1(pct(cum(20), ing.length))})`);
  console.log('\n  ingr merc wal  categoria             tipo                  famiglia');
  for (const [k, v] of ordinate.slice(0, 12)) {
    console.log(`  ${String(v.n).padStart(4)} ${String(v.mercati.size).padStart(4)} ${String(v.wallet.size).padStart(3)}  `
      + `${v.cat.padEnd(21)} ${v.tipo.padEnd(21)} ${k.slice(0, 34)}`);
  }

  console.log('\n⑤ DENTRO LE CATEGORIE PIÙ FREQUENTI');
  const sp = ing.filter((r) => categoriaDi(r).categoria === 'sport');
  const tipoSport = (r) => {
    const s = String(r.eventSlug || r.slug || '');
    if (/-more-markets/.test(s)) return 'derivato: O/U, spread, BTTS';
    if (/-exact-score/.test(s)) return 'derivato: risultato esatto';
    if (/-first-to-score/.test(s)) return 'derivato: primo a segnare';
    if (/-halftime-result/.test(s)) return 'derivato: primo tempo';
    if (/-total-corners/.test(s)) return 'derivato: calci d\'angolo';
    return 'linea principale (1X2 / vincente)';
  };
  const ts2 = {}; for (const r of sp) ts2[tipoSport(r)] = (ts2[tipoSport(r)] || 0) + 1;
  console.log(`  sport (${sp.length} ingressi):`);
  for (const [k, n] of Object.entries(ts2).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)} ${p1(pct(n, sp.length)).padStart(7)}  ${k}`);
  const cr = ing.filter((r) => categoriaDi(r).categoria === 'crypto');
  const w = {}; for (const r of cr) { const m = String(r.eventSlug || '').match(/^([a-z]+)-updown-(\d+m)/); const k = m ? `${m[1].toUpperCase()} ${m[2]}` : 'altre forme (giornaliere, soglie)'; w[k] = (w[k] || 0) + 1; }
  console.log(`  crypto (${cr.length} ingressi):`);
  for (const [k, n] of Object.entries(w).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)} ${p1(pct(n, cr.length)).padStart(7)}  ${k}`);
  console.log(`    montepremi: ${cr.filter((r) => Number(r.montepremiGiorno) > 0).length}/${cr.length} ingressi su un mercato che paga`);

  console.log('\n⑥ ORIZZONTE E SIZE, per categoria (i 21)');
  console.log('categoria'.padEnd(24) + 'nozMed'.padStart(9) + 'oreMed'.padStart(9) + 'affollMed'.padStart(11) + 'potMed'.padStart(9));
  for (const cat of CATEGORIE) {
    const a = ing.filter((r) => categoriaDi(r).categoria === cat); if (!a.length) continue;
    const noz = a.map((r) => r.primoFill && Number(r.primoFill.nozionale)).filter(Number.isFinite);
    const ore = a.map((r) => Number(r.oreAScadenza)).filter((x) => Number.isFinite(x) && x > -100);
    const aff = a.map((r) => Number(r.affollamento)).filter(Number.isFinite);
    const pt = a.map((r) => Number(r.montepremiGiorno)).filter((x) => Number.isFinite(x) && x > 0);
    console.log(cat.padEnd(24) + `$${(med(noz) || 0).toFixed(2)}`.padStart(9)
      + (med(ore) == null ? '—' : med(ore).toFixed(1)).padStart(9)
      + String(med(aff) ?? '—').padStart(11) + `$${med(pt) ?? 0}`.padStart(9));
  }
  const oreP = prem.map((r) => Number(r.oreAScadenza)).filter((x) => Number.isFinite(x) && x > -100);
  const oreN = ing.filter((r) => r.nelProgrammaPremi !== true).map((r) => Number(r.oreAScadenza)).filter((x) => Number.isFinite(x) && x > -100);
  console.log(`\n  orizzonte mediano · premianti ${med(oreP).toFixed(1)}h  ·  NON premianti ${med(oreN).toFixed(1)}h`);

  if (!CON_UNIVERSO) { console.log('\n(--universo per interrogare anche Gamma: cosa esiste di premiante nelle prossime 48 ore)\n'); return; }

  // ── L'UNIVERSO PREMIANTE, DALL'API PUBBLICA ────────────────────────────────────────────────────
  // Paginazione a 100: Gamma IGNORA `limit` oltre 100 e restituisce comunque una pagina da 100. Una
  // sweep scritta con limit=500 e uscita su `len<500` si ferma dopo la prima pagina di ogni fetta e
  // sottostima l'universo di un ordine di grandezza — misurato: 69 premiati contro 216.
  const g = (u) => new Promise((res, rej) => { https.get(u, { headers: { accept: 'application/json' } }, (r) => { let s = ''; r.on('data', (d) => { s += d; }); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej); });
  const potDi = (m) => { try { const cr2 = typeof m.clobRewards === 'string' ? JSON.parse(m.clobRewards) : (m.clobRewards || []); let p = 0; for (const x of cr2) { const v = Number(x.rewardsDailyRate); if (Number.isFinite(v)) p = Math.max(p, v); } return p; } catch { return 0; } };
  const ora = Date.now(); const trovati = new Map(); let tronche = 0;
  for (let i = 0; i < 8; i += 1) {
    const a = new Date(ora + i * 6 * 3600e3).toISOString(); const b = new Date(ora + (i + 1) * 6 * 3600e3).toISOString();
    for (let off = 0; ; off += 100) {
      let j; try { j = await g(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&offset=${off}&end_date_min=${encodeURIComponent(a)}&end_date_max=${encodeURIComponent(b)}`); } catch { break; }
      const arr = Array.isArray(j) ? j : [];
      for (const m of arr) trovati.set(m.conditionId || m.slug, m);
      if (arr.length < 100) break;
      if (off >= 2000) { tronche += 1; break; }
    }
  }
  const tutti = [...trovati.values()];
  const premiati = tutti.filter((m) => potDi(m) > 0);
  const conBanda = premiati.filter((m) => Number(m.rewardsMaxSpread) > 0);
  console.log(`\n⑦ UNIVERSO PREMIANTE 0→48h (Gamma, sola lettura)`);
  console.log(`  mercati attivi visti: ${tutti.length} · fette troncate al tetto: ${tronche}`);
  console.log(`  con montepremi > 0: ${premiati.length} · di cui con banda pubblicata: ${conBanda.length}`
    + ` · scartati da agent24 per banda assente: ${premiati.length - conBanda.length}`);
  const cUni = conta(conBanda, (m) => ({ slug: m.slug, eventSlug: m.slug, titolo: m.question }));
  tabella('  composizione dell\'universo premiante contro il board e i 21', [
    { nome: 'universo 48h', dati: cUni }, { nome: 'board bot', dati: cBoard }, { nome: '21 · premianti', dati: cPrem },
  ]);
  const ore48 = (m) => (Date.parse(m.endDate) - ora) / 3600e3;
  console.log(`\n  premianti sotto le 6 ore: ${conBanda.filter((m) => ore48(m) < 6).length}`
    + ` · fra 6 e 36 ore: ${conBanda.filter((m) => ore48(m) >= 6 && ore48(m) < 36).length}`
    + ` · oltre 36 ore: ${conBanda.filter((m) => ore48(m) >= 36).length}`);
  console.log('');
})().catch((e) => { console.error(e); process.exit(1); });
